// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AccruePayroll} from "../src/AccruePayroll.sol";
import {LitUSD} from "../src/LitUSD.sol";

/// Deploys AccruePayroll. Set LUSD to reuse an existing LitUSD token; otherwise a new one is deployed.
contract Deploy is Script {
    function run() external returns (AccruePayroll payroll, LitUSD lusd) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address existing = vm.envOr("LUSD", address(0));
        require(existing == address(0) || existing.code.length != 0, "LUSD has no contract code");
        vm.startBroadcast(pk);
        payroll = new AccruePayroll();
        lusd = existing == address(0) ? new LitUSD() : LitUSD(existing);
        vm.stopBroadcast();

        console2.log("AccruePayroll:", address(payroll));
        console2.log("LitUSD:", address(lusd));
    }
}
