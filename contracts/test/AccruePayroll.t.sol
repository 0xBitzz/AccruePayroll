// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {AccruePayroll} from "../src/AccruePayroll.sol";
import {Calendar} from "../src/Calendar.sol";
import {LitUSD} from "../src/LitUSD.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract RejectingReceiver {
    receive() external payable {
        revert("no");
    }
}

contract RecoveringReceiver {
    bool public rejecting = true;

    function recover() external {
        rejecting = false;
    }

    receive() external payable {
        require(!rejecting, "not ready");
    }
}

contract ReenteringReceiver {
    address public target;
    bytes public payload;
    bool public succeeded;

    function configure(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    receive() external payable {
        (succeeded,) = target.call(payload);
    }
}

contract FaultyToken is ERC20 {
    enum Fault {
        FalseReturn,
        MalformedReturn,
        ExhaustGas
    }

    address public blocked;
    Fault public fault;

    constructor(address blocked_, Fault fault_) ERC20("Faulty", "FAULT") {
        blocked = blocked_;
        fault = fault_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (to == blocked && fault == Fault.ExhaustGas) {
            assembly {
                for {} 1 {} {}
            }
        }
        super.transfer(to, amount);
        if (to == blocked) {
            if (fault == Fault.FalseReturn) return false;
            assembly {
                mstore(0, 2)
                return(0, 32)
            }
        }
        return true;
    }
}

contract CalendarHarness {
    function period(uint8 payDay, uint256 t) external pure returns (uint256, uint256) {
        return Calendar.period(payDay, t);
    }

    function paydaysBetween(uint8 payDay, uint256 a, uint256 b) external pure returns (uint256) {
        return Calendar.paydaysBetween(payDay, a, b);
    }
}

contract AccruePayrollTest is Test {
    AccruePayroll payroll;
    LitUSD lusd;
    CalendarHarness cal;

    address boss = makeAddr("boss");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address savings = makeAddr("savings");
    address stranger = makeAddr("stranger");

    uint128 constant SALARY = 6 ether;
    uint8 constant PAYDAY = 1;
    uint256 t; // via-IR caches block.timestamp within a test, so track time explicitly

    function _at(uint256 y, uint256 m, uint256 d) internal pure returns (uint256) {
        return Calendar.timestamp(y, m, d);
    }

    function _warp(uint256 ts) internal {
        t = ts;
        vm.warp(ts);
    }

    function setUp() public {
        _warp(_at(2026, 10, 16) + 12 hours); // Fri 16 Oct 2026, 12:00 UTC
        payroll = new AccruePayroll();
        lusd = new LitUSD();
        cal = new CalendarHarness();
        vm.deal(boss, 1_000 ether);
    }

    function _org(uint256 funding) internal returns (uint256 id) {
        vm.startPrank(boss);
        id = payroll.createOrg("Acme", address(0), PAYDAY);
        if (funding > 0) payroll.deposit{value: funding}(id, 0);
        vm.stopPrank();
    }

    /// Adds `who` and has them confirm their wallet, the normal onboarding path.
    function _hire(uint256 id, address who, uint128 salary) internal {
        vm.prank(boss);
        payroll.addMember(id, who, salary, "Someone, Role");
        vm.prank(who);
        payroll.confirmWallet(id);
    }

    function _run(uint256 id) internal returns (uint256) {
        vm.prank(boss);
        return payroll.runPayroll(id);
    }

    function testFuzz_CalendarRoundTrip(uint32 dayNumber) public pure {
        uint256 z = uint256(dayNumber) % 200_000; // ~550 years from 1970
        (uint256 y, uint256 m, uint256 d) = Calendar.fromDays(z);
        assertEq(Calendar.toDays(y, m, d), z);
        assertTrue(m >= 1 && m <= 12 && d >= 1 && d <= 31);
    }

    function test_KnownDates() public pure {
        assertEq(Calendar.timestamp(1970, 1, 1), 0);
        assertEq(Calendar.timestamp(2000, 3, 1), 951_868_800);
        assertEq(Calendar.timestamp(2026, 11, 1), 1_793_491_200);
        assertEq(Calendar.timestamp(2028, 2, 29), 1_835_395_200); // leap day
    }

    function test_PayPeriods() public view {
        (uint256 s, uint256 e) = cal.period(1, t);
        assertEq(s, _at(2026, 10, 1));
        assertEq(e, _at(2026, 11, 1));

        (s, e) = cal.period(25, t); // before the 25th → period started last month
        assertEq(s, _at(2026, 9, 25));
        assertEq(e, _at(2026, 10, 25));

        (s, e) = cal.period(1, _at(2026, 12, 15)); // year wrap
        assertEq(e, _at(2027, 1, 1));
        (s, e) = cal.period(15, _at(2027, 1, 3));
        assertEq(s, _at(2026, 12, 15));

        (s, e) = cal.period(1, _at(2026, 11, 1)); // exactly on payday → a new period starts
        assertEq(s, _at(2026, 11, 1));
        assertEq(e, _at(2026, 12, 1));

        assertEq(cal.paydaysBetween(1, t, _at(2027, 2, 1)), 4); // Nov, Dec, Jan, Feb
        assertEq(cal.paydaysBetween(1, _at(2026, 11, 1), _at(2026, 11, 30)), 0); // (a, b] excludes a
        assertEq(cal.paydaysBetween(28, _at(2027, 2, 1), _at(2027, 3, 1)), 1); // Feb 28
    }

    function test_PayPeriodBeforeFirstEpochPayday() public view {
        (uint256 start, uint256 end) = cal.period(28, 0);
        assertEq(start, 0);
        assertEq(end, _at(1970, 1, 28));
        assertEq(cal.paydaysBetween(28, 0, end - 1), 0);
        assertEq(cal.paydaysBetween(28, 0, end), 1);
        assertEq(cal.paydaysBetween(1, 0, _at(1970, 2, 1)), 1);
    }

    function testFuzz_PaydayCountMatchesCalendarDates(uint32 startDay, uint16 span, uint8 payDay) public view {
        startDay = uint32(bound(startDay, 0, 200_000));
        span = uint16(bound(span, 0, 800));
        payDay = uint8(bound(payDay, 1, 28));
        uint256 from = uint256(startDay) * 1 days + 12 hours;
        uint256 to = from + uint256(span) * 1 days;
        (uint256 year, uint256 month,) = Calendar.fromDays(startDay);
        uint256 expected;
        uint256 payday = _at(year, month, payDay);
        while (payday <= to) {
            if (payday > from) ++expected;
            if (month == 12) {
                ++year;
                month = 1;
            } else {
                ++month;
            }
            payday = _at(year, month, payDay);
        }
        assertEq(cal.paydaysBetween(payDay, from, to), expected);
        assertEq(cal.paydaysBetween(payDay, to, from), 0);
    }

    function test_LongCatchupPayrollHasBoundedGas() public {
        uint256 id = _org(1 ether);
        _hire(id, alice, 1);
        _warp(_at(2526, 1, 1));
        vm.prank(boss);
        uint256 before = gasleft();
        uint256 paid = payroll.runPayroll(id);
        uint256 used = before - gasleft();
        assertEq(paid, 5_991);
        assertEq(alice.balance, paid);
        assertLt(used, 300_000);
    }

    function test_CreateOrg() public {
        uint256 id = _org(10 ether);
        AccruePayroll.OrgView memory o = payroll.getOrg(id);
        assertEq(o.owner, boss);
        assertEq(o.payDay, PAYDAY);
        assertEq(o.treasury, 10 ether);
        assertEq(o.surplus, 10 ether);
        assertEq(o.nextPayday, _at(2026, 11, 1));
        assertEq(payroll.orgsOwnedBy(boss).length, 1);
    }

    function test_RevertWhen_InvalidPayday() public {
        vm.expectRevert(AccruePayroll.InvalidPayday.selector);
        payroll.createOrg("Acme", address(0), 0);
        vm.expectRevert(AccruePayroll.InvalidPayday.selector);
        payroll.createOrg("Acme", address(0), 29);
        vm.expectRevert(AccruePayroll.EmptyName.selector);
        payroll.createOrg("", address(0), 1);
    }

    function test_OnlyOwnerGuards() public {
        uint256 id = _org(10 ether);
        vm.startPrank(stranger);
        vm.expectRevert(AccruePayroll.NotOrgOwner.selector);
        payroll.addMember(id, alice, SALARY, "Alice");
        vm.expectRevert(AccruePayroll.NotOrgOwner.selector);
        payroll.runPayroll(id);
        vm.expectRevert(AccruePayroll.NotOrgOwner.selector);
        payroll.withdrawSurplus(id, 1, stranger);
        vm.expectRevert(AccruePayroll.NotOrgOwner.selector);
        payroll.payBonus(id, alice, 1, "");
        vm.expectRevert(AccruePayroll.UnknownOrg.selector);
        payroll.runPayroll(99);
        vm.stopPrank();
    }

    function test_TransferOwnership() public {
        uint256 id = _org(0);
        vm.prank(boss);
        payroll.transferOrgOwnership(id, stranger);
        assertEq(payroll.getOrg(id).owner, stranger);
        assertEq(payroll.orgsOwnedBy(boss).length, 0);
        assertEq(payroll.orgsOwnedBy(stranger).length, 1);
        vm.prank(boss);
        vm.expectRevert(AccruePayroll.NotOrgOwner.selector);
        payroll.addMember(id, alice, SALARY, "Alice");
    }

    function test_NothingDueBeforeFirstPayday() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        _warp(_at(2026, 10, 31) + 23 hours);
        assertEq(payroll.getMember(id, alice).due, 0);
        vm.prank(boss);
        vm.expectRevert(AccruePayroll.NothingDue.selector);
        payroll.runPayroll(id);
    }

    function test_FullSalaryOnPayday() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY); // hired mid-month: still a fixed salary, no pro-rating
        _warp(_at(2026, 11, 1));
        assertEq(payroll.getMember(id, alice).due, SALARY);
        assertEq(_run(id), SALARY);
        assertEq(alice.balance, SALARY);

        AccruePayroll.OrgView memory o = payroll.getOrg(id);
        assertEq(o.treasury, 100 ether - SALARY);
        assertEq(o.lastPayday, _at(2026, 11, 1));
        assertEq(o.nextPayday, _at(2026, 12, 1));
        assertEq(o.totalPaid, SALARY);
    }

    function test_OneSalaryPerPayday() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        _warp(_at(2026, 11, 1) + 9 hours);
        _run(id);
        _warp(_at(2026, 11, 20));
        vm.prank(boss);
        vm.expectRevert(AccruePayroll.NothingDue.selector);
        payroll.runPayroll(id);
        _warp(_at(2026, 12, 1) + 1);
        assertEq(_run(id), SALARY);
        assertEq(alice.balance, 2 * SALARY);
    }

    function test_MissedPaydaysAccumulate() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        _warp(_at(2027, 2, 3)); // Nov, Dec, Jan, Feb paydays passed
        assertEq(payroll.getOrg(id).due, 4 * SALARY);
        assertEq(_run(id), 4 * SALARY);
    }

    function test_CustomPayday() public {
        vm.prank(boss);
        uint256 id = payroll.createOrg("Acme", address(0), 25);
        vm.prank(boss);
        payroll.deposit{value: 50 ether}(id, 0);
        _hire(id, alice, SALARY);
        assertEq(payroll.getOrg(id).nextPayday, _at(2026, 10, 25));
        _warp(_at(2026, 10, 25));
        assertEq(_run(id), SALARY);
    }

    function test_RevertWhen_TreasuryCantCoverPayroll() public {
        uint256 id = _org(10 ether);
        _hire(id, alice, SALARY);
        _hire(id, bob, SALARY);
        assertEq(payroll.getOrg(id).shortfall, 2 * SALARY - 10 ether);
        _warp(_at(2026, 11, 1));
        vm.prank(boss);
        vm.expectRevert(abi.encodeWithSelector(AccruePayroll.InsufficientTreasury.selector, 2 * SALARY, 10 ether));
        payroll.runPayroll(id);

        vm.prank(boss);
        payroll.deposit{value: 2 ether}(id, 0);
        assertEq(_run(id), 2 * SALARY);
    }

    function test_NextPayrollIsReserved() public {
        uint256 id = _org(10 ether);
        _hire(id, alice, SALARY);
        AccruePayroll.OrgView memory o = payroll.getOrg(id);
        assertEq(o.reserved, SALARY);
        assertEq(o.surplus, 4 ether);

        vm.startPrank(boss);
        vm.expectRevert(abi.encodeWithSelector(AccruePayroll.InsufficientSurplus.selector, 4 ether));
        payroll.withdrawSurplus(id, 4 ether + 1, boss);
        uint256 before = boss.balance;
        payroll.withdrawSurplus(id, 4 ether, boss);
        vm.stopPrank();
        assertEq(boss.balance - before, 4 ether);

        _warp(_at(2026, 11, 1));
        assertEq(_run(id), SALARY); // the reserved salary was still there on payday
    }

    function test_OwedSalaryStaysReservedAfterPayday() public {
        uint256 id = _org(20 ether);
        _hire(id, alice, SALARY);
        _warp(_at(2026, 11, 2)); // Nov 1 passed, payroll not run: 6 owed + 6 next = 12 reserved
        assertEq(payroll.getOrg(id).surplus, 8 ether);
        vm.prank(boss);
        vm.expectRevert(abi.encodeWithSelector(AccruePayroll.InsufficientSurplus.selector, 8 ether));
        payroll.withdrawSurplus(id, 9 ether, boss);
    }

    function test_PausedOnPaydayIsNotPaid() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        vm.prank(boss);
        payroll.pauseMember(id, alice);
        assertEq(payroll.getOrg(id).totalSalary, 0);

        _warp(_at(2026, 11, 1));
        vm.prank(boss);
        vm.expectRevert(AccruePayroll.NothingDue.selector);
        payroll.runPayroll(id);

        _warp(_at(2026, 11, 15));
        vm.prank(boss);
        payroll.resumeMember(id, alice);
        _warp(_at(2026, 12, 1));
        assertEq(_run(id), SALARY);
    }

    function test_SalaryChangeAppliesFromNextPayday() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        _warp(_at(2026, 11, 3)); // Nov 1 passed at the old salary
        vm.prank(boss);
        payroll.setSalary(id, alice, 2 * SALARY);
        assertEq(payroll.getMember(id, alice).due, SALARY);
        assertEq(payroll.getOrg(id).totalSalary, 2 * SALARY);
        _warp(_at(2026, 12, 1));
        assertEq(_run(id), 3 * SALARY); // Nov at 6 + Dec at 12
    }

    function test_TerminatedStillPaidForPassedPaydays() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        _warp(_at(2026, 11, 5));
        vm.prank(boss);
        payroll.terminateMember(id, alice);
        assertEq(payroll.getOrg(id).headcount, 0);
        _warp(_at(2026, 12, 2));
        assertEq(_run(id), SALARY); // November only
        vm.prank(boss);
        vm.expectRevert(AccruePayroll.NothingDue.selector);
        payroll.runPayroll(id);
    }

    function test_RehireKeepsOwedSalary() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        _warp(_at(2026, 11, 5));
        vm.startPrank(boss);
        payroll.terminateMember(id, alice);
        payroll.addMember(id, alice, SALARY, "Alice, Rehired");
        vm.stopPrank();
        assertEq(payroll.getRoster(id).length, 1, "no duplicate roster entry");
        assertEq(payroll.getMemberships(alice).length, 1, "no duplicate membership");
        assertTrue(payroll.getMember(id, alice).confirmed, "re-hire keeps the confirmed wallet");
        _warp(_at(2026, 12, 1));
        assertEq(_run(id), 2 * SALARY);
    }

    function test_UnconfirmedSalaryIsHeldUntilConfirmed() public {
        uint256 id = _org(100 ether);
        vm.prank(boss);
        payroll.addMember(id, alice, SALARY, "Alice, Design");
        assertEq(payroll.getOrg(id).unconfirmed, 1);

        _warp(_at(2026, 11, 1));
        AccruePayroll.OrgView memory o = payroll.getOrg(id);
        assertEq(o.held, SALARY);
        assertEq(o.payable_, 0);
        vm.prank(boss);
        vm.expectRevert(AccruePayroll.NothingDue.selector);
        payroll.runPayroll(id);

        vm.startPrank(alice);
        payroll.confirmWallet(id);
        vm.expectRevert(AccruePayroll.AlreadyConfirmed.selector);
        payroll.confirmWallet(id);
        vm.stopPrank();
        assertEq(_run(id), SALARY);
        assertEq(alice.balance, SALARY);
    }

    function test_UnconfirmedMemberDoesNotBlockOthers() public {
        uint256 id = _org(100 ether);
        vm.prank(boss);
        payroll.addMember(id, alice, SALARY, "Alice, Design"); // never confirms
        _hire(id, bob, SALARY);
        _warp(_at(2026, 11, 1));
        assertEq(_run(id), SALARY);
        assertEq(bob.balance, SALARY);
        assertEq(payroll.getMember(id, alice).due, SALARY, "held, still owed and reserved");
        assertEq(payroll.getOrg(id).reserved, SALARY + 2 * SALARY);
    }

    function test_RevertWhen_StrangerConfirms() public {
        uint256 id = _org(1 ether);
        vm.prank(stranger);
        vm.expectRevert(AccruePayroll.NotMember.selector);
        payroll.confirmWallet(id);
    }

    function test_BonusNeedsConfirmedWallet() public {
        uint256 id = _org(100 ether);
        vm.prank(boss);
        payroll.addMember(id, alice, SALARY, "Alice, Design");
        vm.prank(boss);
        vm.expectRevert(AccruePayroll.WalletNotConfirmed.selector);
        payroll.payBonus(id, alice, 1 ether, "");
    }

    function test_WalletChangeAfterDelay() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        address fresh = makeAddr("alice-new");

        vm.prank(alice);
        payroll.requestWalletChange(id, alice, fresh);
        AccruePayroll.MemberView memory mv = payroll.getMember(id, alice);
        assertEq(mv.pendingWallet, fresh);
        assertEq(mv.changeReadyAt, t + 48 hours);

        vm.prank(fresh);
        vm.expectRevert(abi.encodeWithSelector(AccruePayroll.WalletChangeNotReady.selector, t + 48 hours));
        payroll.acceptWalletChange(id, alice);
        vm.prank(stranger);
        vm.expectRevert(AccruePayroll.NoWalletChange.selector);
        payroll.acceptWalletChange(id, alice);

        // A payday during the window: alice's pay is held rather than sent to a wallet that may be compromised.
        _warp(_at(2026, 11, 1));
        assertEq(payroll.getOrg(id).held, SALARY);
        vm.prank(boss);
        vm.expectRevert(AccruePayroll.NothingDue.selector);
        payroll.runPayroll(id);

        _warp(_at(2026, 11, 1) + 48 hours);
        vm.prank(fresh);
        payroll.acceptWalletChange(id, alice);

        assertEq(payroll.getRoster(id)[0].account, fresh);
        assertEq(payroll.getMemberships(alice).length, 0);
        assertEq(payroll.getMemberships(fresh).length, 1);
        assertTrue(payroll.getMember(id, fresh).confirmed);
        assertEq(payroll.getMember(id, fresh).salary, SALARY);
        assertEq(_run(id), SALARY);
        assertEq(fresh.balance, SALARY);
        assertEq(alice.balance, 0);
    }

    function test_EmployerCanBlockWalletChange() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        address attacker = makeAddr("attacker");
        vm.prank(alice); // e.g. alice's key was stolen
        payroll.requestWalletChange(id, alice, attacker);
        assertEq(payroll.getOrg(id).pendingChanges, 1);

        vm.prank(boss);
        payroll.cancelWalletChange(id, alice);
        _warp(t + 3 days);
        vm.prank(attacker);
        vm.expectRevert(AccruePayroll.NoWalletChange.selector);
        payroll.acceptWalletChange(id, alice);
    }

    function test_EmployerRecoversLostWallet() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        address fresh = makeAddr("alice-new");
        vm.prank(boss);
        payroll.requestWalletChange(id, alice, fresh);
        _warp(t + 48 hours);
        vm.prank(fresh);
        payroll.acceptWalletChange(id, alice);
        assertEq(payroll.getMember(id, fresh).status == AccruePayroll.Status.Active, true);
    }

    function test_EmployeeCanBlockEmployerWalletChange() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        vm.prank(boss);
        payroll.requestWalletChange(id, alice, makeAddr("boss-wallet"));
        vm.prank(alice);
        payroll.cancelWalletChange(id, alice);
        assertEq(payroll.getMember(id, alice).pendingWallet, address(0));
    }

    function test_RevertWhen_WalletChangeUnauthorisedOrInvalid() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        _hire(id, bob, SALARY);
        vm.prank(stranger);
        vm.expectRevert(AccruePayroll.NotAuthorized.selector);
        payroll.requestWalletChange(id, alice, stranger);
        vm.startPrank(alice);
        vm.expectRevert(AccruePayroll.AlreadyMember.selector);
        payroll.requestWalletChange(id, alice, bob);
        vm.expectRevert(AccruePayroll.InvalidAddress.selector);
        payroll.requestWalletChange(id, alice, alice);
        vm.expectRevert(AccruePayroll.NoWalletChange.selector);
        payroll.cancelWalletChange(id, alice);
        vm.stopPrank();
    }

    function test_RevertWhen_AlreadyMember() public {
        uint256 id = _org(1 ether);
        _hire(id, alice, SALARY);
        vm.prank(boss);
        vm.expectRevert(AccruePayroll.AlreadyMember.selector);
        payroll.addMember(id, alice, SALARY, "Alice");
    }

    function test_BulkOnboarding() public {
        uint256 id = _org(100 ether);
        address[] memory accounts = new address[](2);
        uint128[] memory salaries = new uint128[](2);
        string[] memory labels = new string[](2);
        (accounts[0], accounts[1]) = (alice, bob);
        (salaries[0], salaries[1]) = (SALARY, 3 * SALARY);
        (labels[0], labels[1]) = ("Alice, Design", "Bob Jay, Protocol");
        vm.prank(boss);
        payroll.addMembers(id, accounts, salaries, labels);

        AccruePayroll.MemberView[] memory roster = payroll.getRoster(id);
        assertEq(roster.length, 2);
        assertEq(roster[1].label, "Bob Jay, Protocol");
        assertEq(payroll.getOrg(id).totalSalary, 4 * SALARY);
        vm.prank(alice);
        payroll.confirmWallet(id);
        vm.prank(bob);
        payroll.confirmWallet(id);
        _warp(_at(2026, 11, 1));
        assertEq(_run(id), 4 * SALARY);
        assertEq(bob.balance, 3 * SALARY);
    }

    function test_SplitAppliedOnPayroll() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        vm.prank(alice);
        payroll.setSplit(id, savings, 2_500);
        _warp(_at(2026, 11, 1));
        _run(id);
        assertEq(savings.balance, SALARY / 4);
        assertEq(alice.balance, SALARY - SALARY / 4);
    }

    function test_RevertWhen_InvalidSplit() public {
        uint256 id = _org(1 ether);
        _hire(id, alice, SALARY);
        vm.startPrank(alice);
        vm.expectRevert(AccruePayroll.InvalidSplit.selector);
        payroll.setSplit(id, savings, 10_001);
        vm.expectRevert(AccruePayroll.InvalidSplit.selector);
        payroll.setSplit(id, address(0), 100);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(AccruePayroll.NotMember.selector);
        payroll.setSplit(id, savings, 100);
    }

    function test_FailedPaymentDoesNotBlockTeam() public {
        uint256 id = _org(100 ether);
        address bad = address(new RejectingReceiver());
        _hire(id, bad, SALARY);
        _hire(id, alice, SALARY);
        _warp(_at(2026, 11, 1));

        vm.expectEmit(true, true, false, true);
        emit AccruePayroll.PaymentFailed(id, bad, SALARY);
        assertEq(_run(id), SALARY);
        assertEq(alice.balance, SALARY);
        assertEq(payroll.getMember(id, bad).due, SALARY, "still owed");
        assertEq(payroll.getOrg(id).treasury, 100 ether - SALARY);
    }

    function test_RejectedSplitFallsBackToMember() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        address bad = address(new RejectingReceiver());
        vm.prank(alice);
        payroll.setSplit(id, bad, 5_000);
        _warp(_at(2026, 11, 1));
        _run(id);
        assertEq(alice.balance, SALARY);
    }

    function test_FailedMemberSplitIsAtomic() public {
        uint256 id = _org(100 ether);
        address bad = address(new RejectingReceiver());
        _hire(id, bad, SALARY);
        _hire(id, alice, SALARY);
        vm.prank(bad);
        payroll.setSplit(id, savings, 2_500);
        _warp(_at(2026, 11, 1));

        assertEq(_run(id), SALARY);
        assertEq(savings.balance, 0, "failed member's split must roll back");
        assertEq(payroll.getMember(id, bad).due, SALARY);
        assertEq(payroll.getPayslips(id, bad, 10).length, 0);
        assertEq(_run(id), 0, "retry must not send the split again");
        assertEq(savings.balance, 0);
        assertEq(payroll.getOrg(id).treasury, address(payroll).balance);
    }

    function test_FailedMemberSplitRecoversWithoutDoubleSplit() public {
        uint256 id = _org(100 ether);
        RecoveringReceiver receiver = new RecoveringReceiver();
        _hire(id, address(receiver), SALARY);
        vm.prank(address(receiver));
        payroll.setSplit(id, savings, 2_500);
        _warp(_at(2026, 11, 1));
        assertEq(_run(id), 0);

        receiver.recover();
        assertEq(_run(id), SALARY);
        assertEq(savings.balance, SALARY / 4);
        assertEq(address(receiver).balance, SALARY - SALARY / 4);
        AccruePayroll.PayslipView[] memory slips = payroll.getPayslips(id, address(receiver), 10);
        assertEq(slips.length, 1);
        assertEq(slips[0].amount, SALARY);
        assertEq(slips[0].splitAmount, savings.balance);
        assertEq(payroll.getMember(id, address(receiver)).due, 0);
    }

    function test_PayoutCannotChangeSplitDuringTransfer() public {
        uint256 id = _org(100 ether);
        ReenteringReceiver receiver = new ReenteringReceiver();
        _hire(id, address(receiver), SALARY);
        vm.prank(address(receiver));
        payroll.setSplit(id, savings, 2_500);
        receiver.configure(address(payroll), abi.encodeCall(AccruePayroll.setSplit, (id, savings, 5_000)));
        _warp(_at(2026, 11, 1));

        assertEq(_run(id), SALARY);
        assertFalse(receiver.succeeded());
        assertEq(payroll.getMember(id, address(receiver)).splitBps, 2_500);
        assertEq(payroll.getPayslips(id, address(receiver), 1)[0].splitAmount, savings.balance);
    }

    function test_PayoutCannotChangeWalletDuringTransfer() public {
        uint256 id = _org(100 ether);
        ReenteringReceiver receiver = new ReenteringReceiver();
        _hire(id, address(receiver), SALARY);
        receiver.configure(
            address(payroll), abi.encodeCall(AccruePayroll.requestWalletChange, (id, address(receiver), stranger))
        );
        _warp(_at(2026, 11, 1));
        assertEq(_run(id), SALARY);
        assertFalse(receiver.succeeded());
        assertEq(payroll.getMember(id, address(receiver)).pendingWallet, address(0));
    }

    function _faultyTokenPayroll(FaultyToken.Fault fault) internal {
        FaultyToken token = new FaultyToken(bob, fault);
        token.mint(boss, 100 ether);
        vm.startPrank(boss);
        uint256 id = payroll.createOrg("Token failures", address(token), PAYDAY);
        token.approve(address(payroll), 100 ether);
        payroll.deposit(id, 100 ether);
        vm.stopPrank();
        _hire(id, bob, SALARY);
        _hire(id, alice, SALARY);
        _warp(_at(2026, 11, 1));

        assertEq(_run(id), SALARY);
        assertEq(token.balanceOf(bob), 0, "failed token transfers must roll back");
        assertEq(token.balanceOf(alice), SALARY);
        assertEq(payroll.getMember(id, bob).due, SALARY);
        assertEq(payroll.getOrg(id).treasury, token.balanceOf(address(payroll)));
    }

    function test_FalseReturningTokenDoesNotMoveFunds() public {
        _faultyTokenPayroll(FaultyToken.Fault.FalseReturn);
    }

    function test_MalformedTokenReturnDoesNotBlockTeam() public {
        _faultyTokenPayroll(FaultyToken.Fault.MalformedReturn);
    }

    function test_GasExhaustingTokenDoesNotBlockTeam() public {
        _faultyTokenPayroll(FaultyToken.Fault.ExhaustGas);
    }

    function test_LargeBonusAndDepositHistoryStayExact() public {
        uint256 amount = uint256(type(uint128).max) + 1;
        vm.deal(boss, amount);
        uint256 id = _org(amount);
        (AccruePayroll.Entry[] memory entries,,) = payroll.getActivity(id, 0, 1);
        assertEq(entries[0].amount, amount, "deposit history must not truncate");
        _hire(id, alice, 0);
        vm.prank(boss);
        payroll.payBonus(id, alice, amount, "Large token units");
        assertEq(payroll.getPayslips(id, alice, 1)[0].amount, amount);
        (entries,,) = payroll.getActivity(id, 0, 1);
        assertEq(entries[0].amount, amount);
        assertEq(payroll.getMember(id, alice).totalPaid, amount);
    }

    function test_AccumulatedSalaryHistoryStaysExact() public {
        uint128 salary = type(uint128).max;
        uint256 amount = uint256(salary) * 2;
        vm.deal(boss, amount);
        uint256 id = _org(amount);
        _hire(id, alice, salary);
        _warp(_at(2026, 12, 1));
        assertEq(_run(id), amount);
        assertEq(payroll.getPayslips(id, alice, 1)[0].amount, amount);
    }

    function test_CancelledRequestsDoNotHideOtherWalletChanges() public {
        uint256 id = _org(0);
        _hire(id, alice, SALARY);
        _hire(id, bob, SALARY);
        vm.startPrank(boss);
        payroll.requestWalletChange(id, bob, stranger);
        for (uint256 i; i < 21; ++i) {
            payroll.requestWalletChange(id, alice, stranger);
            payroll.cancelWalletChange(id, alice);
        }
        vm.stopPrank();
        AccruePayroll.IncomingView[] memory changes = payroll.incomingWalletChanges(stranger);
        assertEq(changes.length, 1);
        assertEq(changes[0].from, bob);
    }

    function test_AllActiveIncomingWalletChangesAreVisible() public {
        for (uint256 i; i < 21; ++i) {
            uint256 id = _org(0);
            _hire(id, alice, SALARY);
            vm.prank(boss);
            payroll.requestWalletChange(id, alice, stranger);
        }
        assertEq(payroll.incomingWalletChanges(stranger).length, 21);
    }

    function test_RevertWhen_TokenHasNoContract() public {
        vm.prank(boss);
        vm.expectRevert(AccruePayroll.InvalidAddress.selector);
        payroll.createOrg("Invalid token", stranger, PAYDAY);
    }

    function test_RevertWhen_PayrollIsMemberWallet() public {
        uint256 id = _org(0);
        vm.prank(boss);
        vm.expectRevert(AccruePayroll.InvalidAddress.selector);
        payroll.addMember(id, address(payroll), SALARY, "Invalid wallet");
    }

    function test_RevertWhen_PayrollOwnsItself() public {
        uint256 id = _org(0);
        vm.prank(boss);
        vm.expectRevert(AccruePayroll.InvalidAddress.selector);
        payroll.transferOrgOwnership(id, address(payroll));
    }

    function test_RevertWhen_PayrollIsNewWallet() public {
        uint256 id = _org(0);
        _hire(id, alice, SALARY);
        vm.prank(alice);
        vm.expectRevert(AccruePayroll.InvalidAddress.selector);
        payroll.requestWalletChange(id, alice, address(payroll));
    }

    function test_RevertWhen_PayrollIsSplitWallet() public {
        uint256 id = _org(0);
        _hire(id, alice, SALARY);
        vm.prank(alice);
        vm.expectRevert(AccruePayroll.InvalidSplit.selector);
        payroll.setSplit(id, address(payroll), 2_500);
    }

    function test_RevertWhen_TokenWithdrawalReturnsToPayroll() public {
        vm.startPrank(boss);
        uint256 id = payroll.createOrg("Token payroll", address(lusd), 1);
        lusd.drip();
        lusd.approve(address(payroll), 100 ether);
        payroll.deposit(id, 100 ether);
        vm.expectRevert(AccruePayroll.InvalidAddress.selector);
        payroll.withdrawSurplus(id, 10 ether, address(payroll));
        vm.stopPrank();
        assertEq(payroll.getOrg(id).treasury, 100 ether);
        assertEq(lusd.balanceOf(address(payroll)), 100 ether);
    }

    function test_BonusPaidInstantlyFromSurplus() public {
        uint256 id = _org(10 ether);
        _hire(id, alice, SALARY); // 6 reserved, 4 surplus
        vm.startPrank(boss);
        vm.expectRevert(abi.encodeWithSelector(AccruePayroll.InsufficientSurplus.selector, 4 ether));
        payroll.payBonus(id, alice, 5 ether, "too generous");
        payroll.payBonus(id, alice, 1 ether, "Shipped v1");
        vm.stopPrank();
        assertEq(alice.balance, 1 ether);
        assertEq(payroll.getMember(id, alice).totalPaid, 1 ether);
        assertEq(payroll.getOrg(id).surplus, 3 ether);
    }

    function test_BonusRound() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        _hire(id, bob, 0); // bonus-only contractor
        address[] memory accounts = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (accounts[0], accounts[1]) = (alice, bob);
        (amounts[0], amounts[1]) = (1 ether, 3 ether);
        vm.prank(boss);
        payroll.payBonuses(id, accounts, amounts, "Q3");
        assertEq(alice.balance, 1 ether);
        assertEq(bob.balance, 3 ether);
    }

    function test_ActivityLogNewestFirst() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        vm.prank(boss);
        payroll.payBonus(id, alice, 1 ether, "Shipped v1");
        _warp(_at(2026, 11, 1));
        _run(id);

        (AccruePayroll.Entry[] memory e, string[] memory memos, uint256 total) = payroll.getActivity(id, 0, 3);
        assertEq(total, 6); // created, deposited, added, confirmed, bonus, payroll
        assertEq(e.length, 3);
        assertEq(uint256(e[0].action), uint256(AccruePayroll.Action.PayrollRun));
        assertEq(e[0].amount, SALARY);
        assertEq(e[0].extra, 1, "people paid");
        assertEq(uint256(e[1].action), uint256(AccruePayroll.Action.Bonus));
        assertEq(memos[1], "Shipped v1");
        assertEq(uint256(e[2].action), uint256(AccruePayroll.Action.WalletConfirmed));

        (e,, total) = payroll.getActivity(id, 3, 10); // page further back
        assertEq(e.length, 3);
        assertEq(uint256(e[2].action), uint256(AccruePayroll.Action.Created));
        assertEq(e[2].extra, PAYDAY);
    }

    function test_PayslipsFollowWalletChanges() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        vm.prank(alice);
        payroll.setSplit(id, savings, 2_500);
        vm.prank(boss);
        payroll.payBonus(id, alice, 2 ether, "Welcome");
        _warp(_at(2026, 11, 1));
        _run(id);

        address fresh = makeAddr("alice-new");
        vm.prank(alice);
        payroll.requestWalletChange(id, alice, fresh);
        AccruePayroll.IncomingView[] memory inc = payroll.incomingWalletChanges(fresh);
        assertEq(inc.length, 1);
        assertEq(inc[0].from, alice);
        assertEq(inc[0].orgName, "Acme");
        _warp(t + 48 hours);
        vm.prank(fresh);
        payroll.acceptWalletChange(id, alice);
        assertEq(payroll.incomingWalletChanges(fresh).length, 0);
        _warp(_at(2026, 12, 1));
        _run(id);

        AccruePayroll.PayslipView[] memory slips = payroll.getPayslips(id, fresh, 10);
        assertEq(slips.length, 3, "December from the new wallet + November and the bonus from the old one");
        assertFalse(slips[0].bonus);
        assertEq(slips[0].amount, SALARY);
        assertEq(slips[0].splitAmount, SALARY / 4);
        assertFalse(slips[1].bonus);
        assertTrue(slips[2].bonus);
        assertEq(slips[2].memo, "Welcome");
        assertEq(payroll.getPayslips(id, fresh, 1).length, 1, "limit respected");
    }

    function test_ERC20Payroll() public {
        vm.startPrank(boss);
        lusd.drip();
        uint256 id = payroll.createOrg("Stable Co", address(lusd), 1);
        lusd.approve(address(payroll), 20_000e18);
        payroll.deposit(id, 20_000e18);
        payroll.addMember(id, alice, 5_400e18, "Alice, Design");
        vm.stopPrank();
        vm.prank(alice);
        payroll.confirmWallet(id);
        _warp(_at(2026, 11, 1));
        assertEq(_run(id), 5_400e18);
        assertEq(lusd.balanceOf(alice), 5_400e18);
    }

    function test_RevertWhen_NativeSentToTokenOrg() public {
        vm.startPrank(boss);
        uint256 id = payroll.createOrg("Stable Co", address(lusd), 1);
        vm.expectRevert(AccruePayroll.InvalidAmount.selector);
        payroll.deposit{value: 1 ether}(id, 0);
        vm.stopPrank();
    }

    function test_DripCooldown() public {
        vm.startPrank(alice);
        lusd.drip();
        vm.expectRevert(abi.encodeWithSelector(LitUSD.DripCooldown.selector, t + 1 hours));
        lusd.drip();
        _warp(t + 1 hours);
        lusd.drip();
        vm.stopPrank();
        assertEq(lusd.balanceOf(alice), 100_000e18);
    }

    function test_Memberships() public {
        uint256 id = _org(100 ether);
        _hire(id, alice, SALARY);
        AccruePayroll.MembershipView[] memory list = payroll.getMemberships(alice);
        assertEq(list.length, 1);
        assertEq(list[0].orgName, "Acme");
        assertEq(list[0].payDay, PAYDAY);
        assertEq(list[0].nextPayday, _at(2026, 11, 1));
        assertTrue(list[0].funded);
        assertEq(list[0].member.salary, SALARY);
    }

    function test_PayrollGasFor100People() public {
        _payrollGas(100);
    }

    function test_PayrollGasFor250People() public {
        _payrollGas(250);
    }

    function _payrollGas(uint256 count) internal {
        uint256 id = _org(1_000 ether);
        address[] memory accounts = new address[](count);
        uint128[] memory salaries = new uint128[](count);
        string[] memory labels = new string[](count);
        for (uint256 i; i < count; ++i) {
            accounts[i] = address(uint160(0x10000 + i));
            salaries[i] = 1 ether;
            labels[i] = "Person, Role";
        }
        vm.prank(boss);
        payroll.addMembers(id, accounts, salaries, labels);
        for (uint256 i; i < count; ++i) {
            vm.deal(accounts[i], 1); // existing wallets, like real employees'
            vm.prank(accounts[i]);
            payroll.confirmWallet(id);
        }
        _warp(_at(2026, 11, 1));
        vm.prank(boss);
        uint256 g = gasleft();
        assertEq(payroll.runPayroll(id), count * 1 ether);
        g -= gasleft();
        emit log_named_uint("runPayroll people", count);
        emit log_named_uint("runPayroll gas", g);
        // Check both the per-member budget and LitVM's 32M transaction gas limit.
        assertLt(g, count * 110_000 + 200_000);
        assertLt(g, 32_000_000);
    }

    function test_ERC20PayrollGasFor250PeopleWithSplits() public {
        vm.startPrank(boss);
        uint256 id = payroll.createOrg("Max token payroll", address(lusd), PAYDAY);
        lusd.drip();
        lusd.approve(address(payroll), 1_000 ether);
        payroll.deposit(id, 1_000 ether);
        address[] memory accounts = new address[](250);
        uint128[] memory salaries = new uint128[](250);
        string[] memory labels = new string[](250);
        for (uint256 i; i < 250; ++i) {
            accounts[i] = address(uint160(0x10000 + i));
            salaries[i] = 1 ether;
            labels[i] = "Person, Role";
        }
        payroll.addMembers(id, accounts, salaries, labels);
        vm.stopPrank();
        for (uint256 i; i < 250; ++i) {
            vm.startPrank(accounts[i]);
            payroll.confirmWallet(id);
            payroll.setSplit(id, address(uint160(0x20000 + i)), 2_500);
            vm.stopPrank();
        }
        _warp(_at(2026, 11, 1));
        vm.prank(boss);
        uint256 g = gasleft();
        assertEq(payroll.runPayroll(id), 250 ether);
        g -= gasleft();
        emit log_named_uint("ERC20 runPayroll gas, 250 with splits", g);
        assertLt(g, 32_000_000);
        assertEq(lusd.balanceOf(accounts[249]), 0.75 ether);
        assertEq(lusd.balanceOf(address(uint160(0x20000 + 249))), 0.25 ether);
    }

    /// Over any sequence of pauses, raises, terminations and payroll runs, every wei leaving the contract is a
    /// salary for a payday the member was active on, and the treasury always matches the contract balance.
    function testFuzz_PaysExactlyForActivePaydays(uint8[8] memory dayGaps, uint8 payDay) public {
        payDay = uint8(bound(payDay, 1, 28));
        vm.prank(boss);
        uint256 id = payroll.createOrg("Fuzz", address(0), payDay);
        vm.prank(boss);
        payroll.deposit{value: 1_000 ether}(id, 0);
        _hire(id, alice, SALARY);
        _hire(id, bob, 2 * SALARY);

        uint256 expected; // what alice + bob should have been paid by the end
        bool aliceActive = true;
        bool bobActive = true;
        uint128 bobSalary = 2 * SALARY;
        uint256 last = t;

        for (uint256 i; i < dayGaps.length; ++i) {
            uint256 next = t + (uint256(dayGaps[i]) % 45 + 1) * 1 days;
            uint256 paydays = cal.paydaysBetween(payDay, last, next);
            expected += (aliceActive ? SALARY : 0) * paydays + (bobActive ? bobSalary : 0) * paydays;
            _warp(next);
            last = next;

            vm.startPrank(boss);
            if (i % 4 == 0 && aliceActive) {
                aliceActive = false;
                payroll.pauseMember(id, alice);
            } else if (i % 4 == 1 && !aliceActive) {
                aliceActive = true;
                payroll.resumeMember(id, alice);
            }
            if (i == 3) {
                bobSalary = SALARY / 2;
                payroll.setSalary(id, bob, SALARY / 2);
            }
            if (i == 6) {
                bobActive = false;
                payroll.terminateMember(id, bob);
            }
            if (i % 3 == 2 && payroll.getOrg(id).due > 0) payroll.runPayroll(id);
            vm.stopPrank();

            assertEq(address(payroll).balance, payroll.getOrg(id).treasury);
        }
        AccruePayroll.OrgView memory o = payroll.getOrg(id);
        assertEq(alice.balance + bob.balance + o.due, expected);
        assertEq(o.totalPaid, alice.balance + bob.balance);
    }
}
