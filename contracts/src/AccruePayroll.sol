// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Calendar} from "./Calendar.sol";

/// @title AccruePayroll — monthly payroll for LitVM
/// @notice Fixed monthly salaries with reserved treasury funds and confirmed payout wallets.
/// @dev Paydays are 00:00 UTC on days 1-28. Settle accrued salaries before changing salary or status.
///      Wallet changes hold payouts for 48 hours and require acceptance from the new wallet.
contract AccruePayroll is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Active,
        Paused,
        Terminated
    }

    struct Org {
        address owner;
        uint64 createdAt;
        uint8 payDay; // 1-28
        address token; // address(0) = native zkLTC
        uint64 lastPayday; // payday covered by the most recent payroll run (0 = never run)
        uint256 treasury;
        uint256 totalSalary; // Σ monthly salary of active members
        uint256 totalPaid;
        string name;
    }

    struct Member {
        Status status;
        uint16 splitBps;
        bool confirmed; // the member has proven control of this wallet
        uint64 lastSettled;
        uint64 changeReadyAt; // when a pending wallet change can be accepted
        uint32 id; // stable per payroll (roster position + 1), so payslips survive wallet changes
        uint32 payslipCount;
        address splitTo;
        uint128 salary; // per month, in token units
        address pendingWallet; // requested new payout wallet (address(0) = none)
        uint256 due; // salaries for paydays up to lastSettled that haven't been paid yet
        uint256 totalPaid;
        string label;
    }

    struct OrgView {
        uint256 id;
        address owner;
        address token;
        string name;
        uint8 payDay;
        uint64 createdAt;
        uint256 treasury;
        uint256 totalSalary; // monthly payroll of active members
        uint256 due; // owed for paydays that have passed
        uint256 payable_; // the part of `due` that `runPayroll` would send now
        uint256 held; // the part of `due` held for unconfirmed wallets or pending wallet changes
        uint256 reserved; // due + next payday's payroll
        uint256 surplus; // treasury above `reserved`, the only part the owner can withdraw
        uint256 shortfall; // `reserved` above treasury
        uint256 nextPayday;
        uint64 lastPayday;
        uint256 totalPaid;
        uint256 headcount; // active + paused members
        uint256 unconfirmed; // members who haven't confirmed their wallet
        uint256 pendingChanges; // wallet changes waiting out the delay
        uint256 timestamp;
    }

    struct MemberView {
        address account;
        Status status;
        string label;
        uint256 salary;
        uint256 due;
        uint256 totalPaid;
        address splitTo;
        uint16 splitBps;
        bool confirmed;
        address pendingWallet;
        uint64 changeReadyAt;
    }

    struct MembershipView {
        uint256 orgId;
        string orgName;
        address orgOwner;
        address token;
        uint8 payDay;
        uint256 nextPayday;
        bool funded; // treasury covers everything owed plus the next payroll
        MemberView member;
        uint256 timestamp;
    }

    /// @notice Payroll history stored on-chain for reads without log indexing.
    enum Action {
        Created,
        Deposited,
        Withdrew,
        Added,
        SalaryChanged,
        Paused,
        Resumed,
        Removed,
        PayrollRun,
        PaymentFailed,
        Bonus,
        WalletConfirmed,
        WalletChangeRequested,
        WalletChangeCancelled,
        WalletChanged,
        OwnershipTransferred
    }

    /// @dev `amount`/`extra`/`other` depend on the action: PayrollRun (total paid, people paid), SalaryChanged
    ///      (new, old), Bonus (amount, split), WalletChangeRequested (-, readyAt, new wallet), WalletChanged (-, -, old
    ///      wallet), OwnershipTransferred (-, -, new owner), Created (-, payDay).
    struct Entry {
        uint64 at;
        Action action;
        address who;
        uint256 amount;
        uint256 extra;
        address other;
    }

    struct Payslip {
        uint64 at;
        bool bonus;
        uint16 splitBps; // share that went to the split wallet
        uint128 amount; // low token units; a rare large amount is stored separately
        uint32 entry; // activity entry, for a bonus memo
        bool largeAmount;
    }

    struct PayslipView {
        uint64 at;
        bool bonus;
        uint256 amount;
        uint256 splitAmount;
        string memo;
    }

    struct IncomingChange {
        uint256 orgId;
        address from;
    }

    struct IncomingView {
        uint256 orgId;
        string orgName;
        address from;
        uint64 readyAt;
    }

    uint256 public constant MAX_MEMBERS = 250;
    uint16 public constant BPS = 10_000;
    /// @dev Gas forwarded to a native payout and the budget for a token transfer during payroll.
    uint256 public constant PAYOUT_GAS = 100_000;
    /// @notice How long a payout wallet change waits before the new wallet can accept it.
    uint256 public constant WALLET_CHANGE_DELAY = 48 hours;

    uint256 public orgCount;
    mapping(uint256 => Org) internal _orgs;
    mapping(uint256 => mapping(address => Member)) internal _members;
    mapping(uint256 => address[]) internal _roster;
    mapping(address => uint256[]) internal _ownedOrgs;
    mapping(address => uint256[]) internal _memberOrgs;
    mapping(uint256 => Entry[]) internal _log;
    mapping(uint256 => mapping(uint256 => string)) internal _memos; // orgId => entry index => bonus memo
    mapping(uint256 => mapping(uint256 => mapping(uint256 => Payslip))) internal _payslips; // orgId => member id => n
    mapping(uint256 => mapping(uint256 => mapping(uint256 => uint256))) internal _largePayslipAmounts;
    mapping(address => IncomingChange[]) internal _incoming; // active wallet changes pointing at an address

    event OrgCreated(uint256 indexed orgId, address indexed owner, address indexed token, uint8 payDay, string name);
    event OrgOwnershipTransferred(uint256 indexed orgId, address indexed from, address indexed to);
    event Deposited(uint256 indexed orgId, address indexed from, uint256 amount);
    event SurplusWithdrawn(uint256 indexed orgId, address indexed to, uint256 amount);
    event MemberAdded(uint256 indexed orgId, address indexed account, uint256 salary, string label);
    event SalaryChanged(uint256 indexed orgId, address indexed account, uint256 oldSalary, uint256 newSalary);
    event MemberPaused(uint256 indexed orgId, address indexed account);
    event MemberResumed(uint256 indexed orgId, address indexed account);
    event MemberTerminated(uint256 indexed orgId, address indexed account);
    event SplitUpdated(uint256 indexed orgId, address indexed account, address splitTo, uint16 splitBps);
    event WalletConfirmed(uint256 indexed orgId, address indexed account);
    event WalletChangeRequested(
        uint256 indexed orgId, address indexed account, address indexed newWallet, uint64 readyAt, address by
    );
    event WalletChangeCancelled(uint256 indexed orgId, address indexed account, address by);
    event WalletChanged(uint256 indexed orgId, address indexed from, address indexed to);
    event PayrollRun(uint256 indexed orgId, uint256 payday, uint256 total, uint256 count);
    event Paid(uint256 indexed orgId, address indexed account, uint256 amount, uint256 splitAmount, address splitTo);
    event PaymentFailed(uint256 indexed orgId, address indexed account, uint256 amount);
    event BonusPaid(
        uint256 indexed orgId,
        address indexed account,
        uint256 amount,
        uint256 splitAmount,
        address splitTo,
        string memo
    );

    error UnknownOrg();
    error NotOrgOwner();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidSplit();
    error InvalidPayday();
    error EmptyName();
    error LengthMismatch();
    error TooManyMembers();
    error AlreadyMember();
    error NotMember();
    error InvalidStatus();
    error InsufficientSurplus(uint256 surplus);
    error InsufficientTreasury(uint256 needed, uint256 available);
    error NothingDue();
    error TransferFailed();
    error NotAuthorized();
    error AlreadyConfirmed();
    error WalletNotConfirmed();
    error WalletChangePending();
    error NoWalletChange();
    error WalletChangeNotReady(uint256 readyAt);

    modifier orgExists(uint256 orgId) {
        if (orgId == 0 || orgId > orgCount) revert UnknownOrg();
        _;
    }

    modifier onlyOrgOwner(uint256 orgId) {
        if (orgId == 0 || orgId > orgCount) revert UnknownOrg();
        if (_orgs[orgId].owner != msg.sender) revert NotOrgOwner();
        _;
    }

    /// @notice Create a payroll. `token` is the ERC-20 salaries are paid in (address(0) for native zkLTC) and
    ///         `payDay` the day of the month (1-28) salaries fall due, at 00:00 UTC.
    function createOrg(string calldata name, address token, uint8 payDay)
        external
        nonReentrant
        returns (uint256 orgId)
    {
        if (bytes(name).length == 0) revert EmptyName();
        if (payDay == 0 || payDay > 28) revert InvalidPayday();
        if (token != address(0) && token.code.length == 0) revert InvalidAddress();
        orgId = ++orgCount;
        Org storage org = _orgs[orgId];
        org.owner = msg.sender;
        org.token = token;
        org.payDay = payDay;
        org.name = name;
        org.createdAt = uint64(block.timestamp);
        _ownedOrgs[msg.sender].push(orgId);
        _record(orgId, Action.Created, msg.sender, 0, payDay, address(0));
        emit OrgCreated(orgId, msg.sender, token, payDay, name);
    }

    /// @notice Hand a payroll to a new owner, e.g. a multisig.
    function transferOrgOwnership(uint256 orgId, address newOwner) external nonReentrant onlyOrgOwner(orgId) {
        if (newOwner == address(0) || newOwner == address(this)) revert InvalidAddress();
        _orgs[orgId].owner = newOwner;
        _ownedOrgs[newOwner].push(orgId);
        _record(orgId, Action.OwnershipTransferred, msg.sender, 0, 0, newOwner);
        emit OrgOwnershipTransferred(orgId, msg.sender, newOwner);
    }

    /// @notice Top up a payroll's treasury. Anyone can fund any payroll.
    /// @param amount Ignored for native payrolls (msg.value is used).
    function deposit(uint256 orgId, uint256 amount) external payable nonReentrant orgExists(orgId) {
        Org storage org = _orgs[orgId];
        uint256 received;
        if (org.token == address(0)) {
            received = msg.value;
        } else {
            if (msg.value != 0) revert InvalidAmount();
            IERC20 token = IERC20(org.token);
            uint256 before = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), amount);
            received = token.balanceOf(address(this)) - before;
        }
        if (received == 0) revert InvalidAmount();
        org.treasury += received;
        _record(orgId, Action.Deposited, msg.sender, received, 0, address(0));
        emit Deposited(orgId, msg.sender, received);
    }

    /// @notice Withdraw treasury funds that aren't owed or reserved for the next payroll.
    function withdrawSurplus(uint256 orgId, uint256 amount, address to) external nonReentrant onlyOrgOwner(orgId) {
        if (to == address(0) || to == address(this)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        Org storage org = _orgs[orgId];
        uint256 surplus = _surplus(orgId, org);
        if (amount > surplus) revert InsufficientSurplus(surplus);
        org.treasury -= amount;
        _record(orgId, Action.Withdrew, to, amount, 0, address(0));
        _send(org.token, to, amount);
        emit SurplusWithdrawn(orgId, to, amount);
    }

    /// @notice Put `account` on the payroll at a fixed `salary` per month. They're paid on every payday they're
    ///         active for. Re-hiring someone keeps anything they were still owed.
    function addMember(uint256 orgId, address account, uint128 salary, string calldata label)
        external
        nonReentrant
        onlyOrgOwner(orgId)
    {
        _addMember(orgId, account, salary, label);
    }

    /// @notice Onboard a whole team in one transaction.
    function addMembers(
        uint256 orgId,
        address[] calldata accounts,
        uint128[] calldata salaries,
        string[] calldata labels
    ) external nonReentrant onlyOrgOwner(orgId) {
        if (accounts.length != salaries.length || accounts.length != labels.length) revert LengthMismatch();
        for (uint256 i; i < accounts.length; ++i) {
            _addMember(orgId, accounts[i], salaries[i], labels[i]);
        }
    }

    /// @notice Change a member's monthly salary. Applies from the next payday; paydays already passed keep the old one.
    function setSalary(uint256 orgId, address account, uint128 newSalary) external nonReentrant onlyOrgOwner(orgId) {
        Org storage org = _orgs[orgId];
        Member storage m = _members[orgId][account];
        if (m.status != Status.Active && m.status != Status.Paused) revert InvalidStatus();
        _settle(m, org.payDay);
        uint128 old = m.salary;
        if (m.status == Status.Active) org.totalSalary = org.totalSalary - old + newSalary;
        m.salary = newSalary;
        _record(orgId, Action.SalaryChanged, account, newSalary, old, address(0));
        emit SalaryChanged(orgId, account, old, newSalary);
    }

    /// @notice Stop paying a member (e.g. unpaid leave). They aren't paid for paydays while paused.
    function pauseMember(uint256 orgId, address account) external nonReentrant onlyOrgOwner(orgId) {
        Org storage org = _orgs[orgId];
        Member storage m = _members[orgId][account];
        if (m.status != Status.Active) revert InvalidStatus();
        _settle(m, org.payDay);
        org.totalSalary -= m.salary;
        m.status = Status.Paused;
        _record(orgId, Action.Paused, account, 0, 0, address(0));
        emit MemberPaused(orgId, account);
    }

    function resumeMember(uint256 orgId, address account) external nonReentrant onlyOrgOwner(orgId) {
        Org storage org = _orgs[orgId];
        Member storage m = _members[orgId][account];
        if (m.status != Status.Paused) revert InvalidStatus();
        _settle(m, org.payDay);
        org.totalSalary += m.salary;
        m.status = Status.Active;
        _record(orgId, Action.Resumed, account, 0, 0, address(0));
        emit MemberResumed(orgId, account);
    }

    /// @notice Take a member off the payroll. Salaries for paydays that already passed are still paid on the next run.
    function terminateMember(uint256 orgId, address account) external nonReentrant onlyOrgOwner(orgId) {
        Org storage org = _orgs[orgId];
        Member storage m = _members[orgId][account];
        if (m.status != Status.Active && m.status != Status.Paused) revert InvalidStatus();
        _settle(m, org.payDay);
        if (m.status == Status.Active) org.totalSalary -= m.salary;
        m.status = Status.Terminated;
        _record(orgId, Action.Removed, account, 0, 0, address(0));
        emit MemberTerminated(orgId, account);
    }

    /// @notice Pay everyone what they're owed for paydays that have passed. Reverts unless the treasury covers the
    ///         whole run. Salaries for unconfirmed wallets or wallets mid-change are held (still owed) until that's
    ///         resolved, and a recipient whose transfer fails is skipped, so nobody can block the rest of the team.
    function runPayroll(uint256 orgId) external nonReentrant onlyOrgOwner(orgId) returns (uint256 paid) {
        Org storage org = _orgs[orgId];
        address[] storage roster = _roster[orgId];
        uint256 n = roster.length;
        uint256[] memory amounts = new uint256[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            Member storage m = _members[orgId][roster[i]];
            if (!_canPay(m)) continue;
            amounts[i] = _dueNow(m, org.payDay);
            total += amounts[i];
        }
        if (total == 0) revert NothingDue();
        if (total > org.treasury) revert InsufficientTreasury(total, org.treasury);

        uint256 count;
        for (uint256 i; i < n; ++i) {
            if (amounts[i] == 0) continue;
            Member storage m = _members[orgId][roster[i]];
            m.lastSettled = uint64(block.timestamp);
            uint256 sent = _payMember(orgId, org.token, roster[i], m, amounts[i]);
            if (sent != 0) {
                paid += sent;
                ++count;
            }
        }
        org.treasury -= paid;
        org.totalPaid += paid;
        (uint256 payday,) = Calendar.period(org.payDay, block.timestamp);
        org.lastPayday = uint64(payday);
        _record(orgId, Action.PayrollRun, msg.sender, paid, count, address(0));
        emit PayrollRun(orgId, payday, paid, count);
    }

    /// @notice Pay a one-off bonus straight away. Comes out of surplus, never out of reserved salaries.
    function payBonus(uint256 orgId, address account, uint256 amount, string calldata memo)
        external
        nonReentrant
        onlyOrgOwner(orgId)
    {
        Org storage org = _orgs[orgId];
        uint256 surplus = _surplus(orgId, org);
        if (amount > surplus) revert InsufficientSurplus(surplus);
        _payBonus(orgId, org, account, amount, memo);
    }

    /// @notice Pay bonuses to several people at once (e.g. an end-of-quarter bonus round).
    function payBonuses(uint256 orgId, address[] calldata accounts, uint256[] calldata amounts, string calldata memo)
        external
        nonReentrant
        onlyOrgOwner(orgId)
    {
        if (accounts.length != amounts.length) revert LengthMismatch();
        Org storage org = _orgs[orgId];
        uint256 surplus = _surplus(orgId, org);
        uint256 total;
        for (uint256 i; i < amounts.length; ++i) {
            total += amounts[i];
        }
        if (total > surplus) revert InsufficientSurplus(surplus);
        for (uint256 i; i < accounts.length; ++i) {
            _payBonus(orgId, org, accounts[i], amounts[i], memo);
        }
    }

    /// @notice Confirm this is your payout wallet. Nothing is ever sent to a wallet until it's confirmed.
    function confirmWallet(uint256 orgId) external nonReentrant orgExists(orgId) {
        Member storage m = _members[orgId][msg.sender];
        if (m.status == Status.None) revert NotMember();
        if (m.confirmed) revert AlreadyConfirmed();
        m.confirmed = true;
        _record(orgId, Action.WalletConfirmed, msg.sender, 0, 0, address(0));
        emit WalletConfirmed(orgId, msg.sender);
    }

    /// @notice Start moving `account`'s payroll to `newWallet`. Callable by the member, or by the employer when the
    ///         member has lost access to their wallet. Payouts to `account` are held during the 48h window, either
    ///         side can block the change, and afterwards `newWallet` must accept it itself.
    function requestWalletChange(uint256 orgId, address account, address newWallet)
        external
        nonReentrant
        orgExists(orgId)
    {
        if (msg.sender != account && msg.sender != _orgs[orgId].owner) revert NotAuthorized();
        Member storage m = _members[orgId][account];
        if (m.status == Status.None) revert NotMember();
        if (newWallet == address(0) || newWallet == address(this) || newWallet == account) revert InvalidAddress();
        if (_members[orgId][newWallet].status != Status.None) revert AlreadyMember();
        uint64 readyAt = uint64(block.timestamp + WALLET_CHANGE_DELAY);
        _removeIncoming(m.pendingWallet, orgId, account);
        m.pendingWallet = newWallet;
        m.changeReadyAt = readyAt;
        _incoming[newWallet].push(IncomingChange(orgId, account));
        _record(orgId, Action.WalletChangeRequested, account, 0, readyAt, newWallet);
        emit WalletChangeRequested(orgId, account, newWallet, readyAt, msg.sender);
    }

    /// @notice Block a pending wallet change. Callable by the member's current wallet or the employer.
    function cancelWalletChange(uint256 orgId, address account) external nonReentrant orgExists(orgId) {
        if (msg.sender != account && msg.sender != _orgs[orgId].owner) revert NotAuthorized();
        Member storage m = _members[orgId][account];
        if (m.pendingWallet == address(0)) revert NoWalletChange();
        _removeIncoming(m.pendingWallet, orgId, account);
        m.pendingWallet = address(0);
        m.changeReadyAt = 0;
        _record(orgId, Action.WalletChangeCancelled, account, 0, 0, msg.sender);
        emit WalletChangeCancelled(orgId, account, msg.sender);
    }

    /// @notice Called from the new wallet once the delay has passed: moves the membership (and anything owed) to it.
    function acceptWalletChange(uint256 orgId, address from) external nonReentrant orgExists(orgId) {
        Member storage old = _members[orgId][from];
        if (old.pendingWallet == address(0) || old.pendingWallet != msg.sender) revert NoWalletChange();
        if (block.timestamp < old.changeReadyAt) revert WalletChangeNotReady(old.changeReadyAt);
        if (_members[orgId][msg.sender].status != Status.None) revert AlreadyMember();

        _removeIncoming(msg.sender, orgId, from);
        _members[orgId][msg.sender] = old;
        Member storage moved = _members[orgId][msg.sender];
        moved.confirmed = true; // accepting from the wallet proves control of it
        moved.pendingWallet = address(0);
        moved.changeReadyAt = 0;
        delete _members[orgId][from];

        address[] storage roster = _roster[orgId];
        for (uint256 i; i < roster.length; ++i) {
            if (roster[i] == from) {
                roster[i] = msg.sender;
                break;
            }
        }
        _trackMembership(msg.sender, orgId);
        _record(orgId, Action.WalletChanged, msg.sender, 0, 0, from);
        emit WalletChanged(orgId, from, msg.sender);
    }

    /// @notice Automatically route a share of every payout to another address (savings, tax wallet, …).
    function setSplit(uint256 orgId, address splitTo, uint16 splitBps) external nonReentrant orgExists(orgId) {
        Member storage m = _members[orgId][msg.sender];
        if (m.status == Status.None) revert NotMember();
        if (splitBps > BPS || (splitBps != 0 && (splitTo == address(0) || splitTo == address(this)))) {
            revert InvalidSplit();
        }
        m.splitTo = splitBps == 0 ? address(0) : splitTo;
        m.splitBps = splitBps;
        emit SplitUpdated(orgId, msg.sender, m.splitTo, splitBps);
    }

    function getOrg(uint256 orgId) public view orgExists(orgId) returns (OrgView memory v) {
        Org storage org = _orgs[orgId];
        address[] storage roster = _roster[orgId];
        for (uint256 i; i < roster.length; ++i) {
            Member storage m = _members[orgId][roster[i]];
            uint256 due = _dueNow(m, org.payDay);
            v.due += due;
            if (_canPay(m)) v.payable_ += due;
            else v.held += due;
            if (m.status == Status.Active || m.status == Status.Paused) ++v.headcount;
            if (!m.confirmed) ++v.unconfirmed;
            if (m.pendingWallet != address(0)) ++v.pendingChanges;
        }
        v.id = orgId;
        v.owner = org.owner;
        v.token = org.token;
        v.name = org.name;
        v.payDay = org.payDay;
        v.createdAt = org.createdAt;
        v.treasury = org.treasury;
        v.totalSalary = org.totalSalary;
        v.reserved = v.due + org.totalSalary;
        v.surplus = org.treasury > v.reserved ? org.treasury - v.reserved : 0;
        v.shortfall = v.reserved > org.treasury ? v.reserved - org.treasury : 0;
        (, v.nextPayday) = Calendar.period(org.payDay, block.timestamp);
        v.lastPayday = org.lastPayday;
        v.totalPaid = org.totalPaid;
        v.timestamp = block.timestamp;
    }

    function getRoster(uint256 orgId) external view orgExists(orgId) returns (MemberView[] memory list) {
        address[] storage roster = _roster[orgId];
        list = new MemberView[](roster.length);
        for (uint256 i; i < roster.length; ++i) {
            list[i] = _memberView(orgId, roster[i]);
        }
    }

    function getMember(uint256 orgId, address account) external view orgExists(orgId) returns (MemberView memory) {
        return _memberView(orgId, account);
    }

    /// @notice Every payroll `account` is currently on, with their salary and payday.
    function getMemberships(address account) external view returns (MembershipView[] memory list) {
        uint256[] storage ids = _memberOrgs[account];
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            if (_members[ids[i]][account].status != Status.None) ++n; // skip payrolls moved to another wallet
        }
        list = new MembershipView[](n);
        n = 0;
        for (uint256 i; i < ids.length; ++i) {
            if (_members[ids[i]][account].status == Status.None) continue;
            OrgView memory o = getOrg(ids[i]);
            list[n++] = MembershipView({
                orgId: ids[i],
                orgName: o.name,
                orgOwner: o.owner,
                token: o.token,
                payDay: o.payDay,
                nextPayday: o.nextPayday,
                funded: o.shortfall == 0,
                member: _memberView(ids[i], account),
                timestamp: block.timestamp
            });
        }
    }

    /// @notice Payrolls currently owned by `owner`.
    function orgsOwnedBy(address owner) external view returns (uint256[] memory ids) {
        uint256[] storage all = _ownedOrgs[owner];
        uint256 n;
        ids = new uint256[](all.length);
        for (uint256 i; i < all.length; ++i) {
            uint256 id = all[i];
            if (_orgs[id].owner != owner) continue;
            bool seen;
            for (uint256 j; j < n; ++j) {
                if (ids[j] == id) seen = true;
            }
            if (!seen) ids[n++] = id;
        }
        assembly {
            mstore(ids, n)
        }
    }

    /// @notice The pay period containing `t` for a given payday: [latest payday ≤ t, next payday).
    function payPeriod(uint8 payDay, uint256 t) external pure returns (uint256 start, uint256 end) {
        if (payDay == 0 || payDay > 28) revert InvalidPayday();
        return Calendar.period(payDay, t);
    }

    /// @notice A payroll's activity, newest first. Pass `before` = 0 for the latest entries, or the index of the
    ///         oldest entry already shown to page further back. Bonus memos are filled in.
    function getActivity(uint256 orgId, uint256 before, uint256 limit)
        external
        view
        orgExists(orgId)
        returns (Entry[] memory entries, string[] memory memos, uint256 total)
    {
        Entry[] storage log = _log[orgId];
        total = log.length;
        uint256 end = before == 0 || before > total ? total : before;
        uint256 n = limit < end ? limit : end;
        entries = new Entry[](n);
        memos = new string[](n);
        for (uint256 i; i < n; ++i) {
            uint256 idx = end - 1 - i;
            entries[i] = log[idx];
            if (log[idx].action == Action.Bonus) memos[i] = _memos[orgId][idx];
        }
    }

    /// @notice Everything paid to `account` in a payroll, newest first. Payslips belong to the member rather than the
    ///         wallet, so they carry over a wallet change.
    function getPayslips(uint256 orgId, address account, uint256 limit)
        external
        view
        returns (PayslipView[] memory list)
    {
        Member storage m = _members[orgId][account];
        uint256 count = m.payslipCount;
        uint256 n = limit < count ? limit : count;
        list = new PayslipView[](n);
        for (uint256 i; i < n; ++i) {
            uint256 index = count - 1 - i;
            Payslip storage p = _payslips[orgId][m.id][index];
            uint256 amount = p.largeAmount ? _largePayslipAmounts[orgId][m.id][index] : p.amount;
            list[i] = PayslipView({
                at: p.at,
                bonus: p.bonus,
                amount: amount,
                splitAmount: _splitAmount(amount, p.splitBps),
                memo: p.bonus ? _memos[orgId][p.entry] : ""
            });
        }
    }

    /// @notice All active wallet changes pointing at `wallet`.
    function incomingWalletChanges(address wallet) external view returns (IncomingView[] memory list) {
        IncomingChange[] storage all = _incoming[wallet];
        list = new IncomingView[](all.length);
        for (uint256 i = all.length; i > 0; --i) {
            IncomingChange storage c = all[i - 1];
            Member storage m = _members[c.orgId][c.from];
            list[all.length - i] = IncomingView(c.orgId, _orgs[c.orgId].name, c.from, m.changeReadyAt);
        }
    }

    function _addMember(uint256 orgId, address account, uint128 salary, string calldata label) internal {
        if (account == address(0) || account == address(this)) revert InvalidAddress();
        Org storage org = _orgs[orgId];
        Member storage m = _members[orgId][account];
        if (m.status == Status.Active || m.status == Status.Paused) revert AlreadyMember();
        if (m.status == Status.None) {
            if (_roster[orgId].length >= MAX_MEMBERS) revert TooManyMembers();
            _roster[orgId].push(account);
            m.id = uint32(_roster[orgId].length);
            _trackMembership(account, orgId);
        }
        _settle(m, org.payDay); // a re-hire keeps what they were owed
        org.totalSalary += salary;
        m.status = Status.Active;
        m.salary = salary;
        m.label = label;
        _record(orgId, Action.Added, account, salary, 0, address(0));
        emit MemberAdded(orgId, account, salary, label);
    }

    function _dueNow(Member storage m, uint8 payDay) internal view returns (uint256) {
        if (m.status != Status.Active) return m.due;
        return m.due + m.salary * Calendar.paydaysBetween(payDay, m.lastSettled, block.timestamp);
    }

    /// @dev Salaries only ever go to a confirmed wallet that isn't mid-change.
    function _canPay(Member storage m) internal view returns (bool) {
        return m.confirmed && m.pendingWallet == address(0);
    }

    /// @dev An address can leave a payroll (wallet change) and later rejoin it, so avoid duplicate entries.
    function _trackMembership(address account, uint256 orgId) internal {
        uint256[] storage ids = _memberOrgs[account];
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == orgId) return;
        }
        ids.push(orgId);
    }

    function _removeIncoming(address wallet, uint256 orgId, address from) internal {
        if (wallet == address(0)) return;
        IncomingChange[] storage all = _incoming[wallet];
        for (uint256 i; i < all.length; ++i) {
            if (all[i].orgId == orgId && all[i].from == from) {
                all[i] = all[all.length - 1];
                all.pop();
                return;
            }
        }
    }

    function _settle(Member storage m, uint8 payDay) internal {
        m.due = _dueNow(m, payDay);
        m.lastSettled = uint64(block.timestamp);
    }

    /// @dev Owed salaries plus the next payroll must stay in the treasury.
    function _surplus(uint256 orgId, Org storage org) internal view returns (uint256) {
        uint256 reserved = org.totalSalary;
        address[] storage roster = _roster[orgId];
        for (uint256 i; i < roster.length; ++i) {
            reserved += _dueNow(_members[orgId][roster[i]], org.payDay);
        }
        return org.treasury > reserved ? org.treasury - reserved : 0;
    }

    /// @dev Each member's payment runs in its own call so failed transfers roll back the split and token state.
    ///      The caller settles `lastSettled` and updates the org totals once for the whole run.
    function _payMember(uint256 orgId, address token, address account, Member storage m, uint256 amount)
        internal
        returns (uint256 sent)
    {
        m.due = 0;
        try this.executePayrollPayment{gas: 2 * PAYOUT_GAS + 50_000}(token, account, m.splitTo, m.splitBps, amount)
        returns (uint256 splitAmount) {
            sent = amount;
            m.totalPaid += amount;
            uint16 bps = splitAmount == 0 ? 0 : m.splitBps;
            _storePayslip(orgId, m, false, bps, amount, 0);
            emit Paid(orgId, account, amount, splitAmount, splitAmount == 0 ? address(0) : m.splitTo);
        } catch {
            m.due = amount;
            _record(orgId, Action.PaymentFailed, account, amount, 0, address(0));
            emit PaymentFailed(orgId, account, amount);
        }
    }

    /// @dev Only callable by this contract. A nested call isolates a failing split, allowing a full-wallet fallback.
    ///      Reverting the outer call rolls back every transfer for this member while the payroll can continue.
    function executePayrollPayment(address token, address account, address splitTo, uint16 splitBps, uint256 amount)
        external
        returns (uint256 splitAmount)
    {
        if (msg.sender != address(this)) revert NotAuthorized();
        splitAmount = _splitAmount(amount, splitBps);
        if (splitAmount != 0) {
            try this.executePayrollPayment{gas: PAYOUT_GAS + 20_000}(token, splitTo, address(0), 0, splitAmount) {}
            catch {
                splitAmount = 0;
            }
        }
        uint256 remainder = amount - splitAmount;
        if (remainder == 0) return splitAmount;
        if (token == address(0)) {
            (bool ok,) = account.call{value: remainder, gas: PAYOUT_GAS}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(account, remainder);
        }
    }

    /// @dev Equivalent to amount * bps / BPS without overflowing for large token-unit amounts.
    function _splitAmount(uint256 amount, uint16 bps) internal pure returns (uint256) {
        return (amount / BPS) * bps + ((amount % BPS) * bps) / BPS;
    }

    function _payBonus(uint256 orgId, Org storage org, address account, uint256 amount, string calldata memo)
        internal
    {
        Member storage m = _members[orgId][account];
        if (m.status == Status.None) revert NotMember();
        if (amount == 0) revert InvalidAmount();
        if (!m.confirmed) revert WalletNotConfirmed();
        if (m.pendingWallet != address(0)) revert WalletChangePending();
        org.treasury -= amount;
        org.totalPaid += amount;
        m.totalPaid += amount;
        uint256 splitAmount = _splitAmount(amount, m.splitBps);
        _logBonus(orgId, account, m, splitAmount == 0 ? 0 : m.splitBps, amount, splitAmount, memo);
        _send(org.token, m.splitTo, splitAmount);
        _send(org.token, account, amount - splitAmount);
        emit BonusPaid(orgId, account, amount, splitAmount, splitAmount == 0 ? address(0) : m.splitTo, memo);
    }

    /// @dev Split out of `_payBonus` to keep the stack shallow.
    function _logBonus(
        uint256 orgId,
        address account,
        Member storage m,
        uint16 splitBps,
        uint256 amount,
        uint256 splitAmount,
        string calldata memo
    ) internal {
        uint32 entry = _record(orgId, Action.Bonus, account, amount, splitAmount, address(0));
        if (bytes(memo).length != 0) _memos[orgId][entry] = memo;
        _storePayslip(orgId, m, true, splitBps, amount, entry);
    }

    /// @dev Normal amounts fit in one storage slot with their metadata. Large token-unit payments remain exact.
    function _storePayslip(uint256 orgId, Member storage m, bool bonus, uint16 bps, uint256 amount, uint32 entry)
        internal
    {
        uint256 index = m.payslipCount++;
        bool large = amount > type(uint128).max;
        _payslips[orgId][m.id][index] = Payslip(uint64(block.timestamp), bonus, bps, uint128(amount), entry, large);
        if (large) _largePayslipAmounts[orgId][m.id][index] = amount;
    }

    function _record(uint256 orgId, Action action, address who, uint256 amount, uint256 extra, address other)
        internal
        returns (uint32 index)
    {
        Entry[] storage log = _log[orgId];
        index = uint32(log.length);
        log.push(Entry(uint64(block.timestamp), action, who, amount, extra, other));
    }

    function _memberView(uint256 orgId, address account) internal view returns (MemberView memory v) {
        Member storage m = _members[orgId][account];
        v.account = account;
        v.status = m.status;
        v.label = m.label;
        v.salary = m.salary;
        v.due = _dueNow(m, _orgs[orgId].payDay);
        v.totalPaid = m.totalPaid;
        v.splitTo = m.splitTo;
        v.splitBps = m.splitBps;
        v.confirmed = m.confirmed;
        v.pendingWallet = m.pendingWallet;
        v.changeReadyAt = m.changeReadyAt;
    }

    /// @dev Reverting transfer, for owner-initiated payouts.
    function _send(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
