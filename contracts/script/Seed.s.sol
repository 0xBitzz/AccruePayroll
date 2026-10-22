// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AccruePayroll} from "../src/AccruePayroll.sol";
import {LitUSD} from "../src/LitUSD.sol";

/// Seeds three confirmed employees, a funded treasury and an instant bonus.
contract Seed is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        AccruePayroll payroll = AccruePayroll(vm.envAddress("PAYROLL"));
        LitUSD lusd = LitUSD(vm.envAddress("LUSD"));

        uint256[3] memory keys = [
            vm.envUint("DEMO_MAYA_PRIVATE_KEY"),
            vm.envUint("DEMO_KENJI_PRIVATE_KEY"),
            vm.envUint("DEMO_ADA_PRIVATE_KEY")
        ];
        address[] memory team = new address[](3);
        uint128[] memory salaries = new uint128[](3);
        string[] memory labels = new string[](3);
        for (uint256 i; i < 3; ++i) {
            team[i] = vm.addr(keys[i]);
        }
        salaries[0] = 5_400e18;
        salaries[1] = 8_200e18;
        salaries[2] = 4_600e18;
        labels[0] = "Maya Chen, Design";
        labels[1] = "Kenji Sato, Protocol";
        labels[2] = "Ada Obi, Growth";

        vm.startBroadcast(pk);
        uint256 orgId = payroll.createOrg("AccruePayroll Demo Co", address(lusd), 1);
        if (lusd.balanceOf(vm.addr(pk)) < 45_000e18) lusd.drip();
        lusd.approve(address(payroll), type(uint256).max);
        payroll.deposit(orgId, 45_000e18);
        payroll.addMembers(orgId, team, salaries, labels);
        for (uint256 i; i < 3; ++i) {
            payable(team[i]).transfer(0.0005 ether); // gas for confirming their wallet
        }
        vm.stopBroadcast();

        for (uint256 i; i < 3; ++i) {
            vm.broadcast(keys[i]);
            payroll.confirmWallet(orgId);
        }

        vm.broadcast(pk);
        payroll.payBonus(orgId, team[1], 500e18, "Shipped on LitVM");

        console2.log("Demo org id:", orgId);
    }
}
