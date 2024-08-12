// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../../../contracts/Vault.sol";
import "../../../contracts/test/TestERC20.sol";

contract InvalidWithdrawalTest is Test {
    uint256 forkBlock = 105_302_472; // Optimiam mainnet @ Thu Jun  8 05:55:21 UTC 2023

    Vault vault;
    TestERC20 usdc;
    TestERC20 weth;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("optimism"), forkBlock);
        vault = Vault(0xAD7b4C162707E0B2b5f6fdDbD3f8538A5fbA0d60);
        usdc = TestERC20(vault.getSettlementToken());
        weth = TestERC20(0x4200000000000000000000000000000000000006);

        deal(address(usdc), address(this), 1000 * 1e6, true);
    }

    function test_exploit() external payable {
        // Step 1: Deposit 1000 USDC into the Vault
        // Assume the attacker already has 1000 USDC
        usdc.approve(address(vault), 1000 * 1e6); // Approve Vault to spend USDC
        vault.deposit(address(usdc), 1000 * 1e6); // Deposit 1000 USDC
        assertEq(vault.getBalanceByToken(address(this), address(usdc)), 1000 * 1e6);
        assertEq(vault.getBalanceByToken(address(this), address(weth)), 0);

        // Step 2: Withdraw 1 wei
        vm.expectRevert("V_NEFC");
        vault.withdrawEther(1); // Attempt to withdraw 1 wei
    }
}
