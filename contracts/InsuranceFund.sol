// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { Vault } from "./Vault.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";

contract InsuranceFund is ReentrancyGuardUpgradeable, OwnerPausable {
    using AddressUpgradeable for address;

    // TODO should be immutable, check how to achieve this in oz upgradeable framework.
    address public vault;
    address private _token;
    uint256 public vaultDebt;

    event Borrowed(address vault, uint256 amount);

    function initialize(address vaultArg) external initializer {
        // IF_ANC: vault address is not contract
        require(vaultArg.isContract(), "IF_ANC");

        __ReentrancyGuard_init();
        __OwnerPausable_init();

        vault = vaultArg;
        _token = Vault(vaultArg).settlementToken();
    }

    function borrow(uint256 amount) external {
        // IF_OV: only vault
        require(_msgSender() == vault, "IF_OV");
        // IF_NEB: not enough balance
        require(IERC20Metadata(_token).balanceOf(address(this)) >= amount, "IF_NEB");

        vaultDebt += amount;
        TransferHelper.safeTransfer(_token, vault, amount);

        emit Borrowed(vault, amount);
    }
}
