// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";

contract InsuranceFund is ReentrancyGuardUpgradeable, OwnerPausable {
    using AddressUpgradeable for address;

    // TODO should be immutable, check how to achieve this in oz upgradeable framework.
    address public borrower;
    address public token;

    event Borrowed(address vault, uint256 amount);

    function initialize(address settlementTokenArg) external initializer {
        // IF_STNC: sttlement token address is not contract
        require(settlementTokenArg.isContract(), "IF_STNC");

        __ReentrancyGuard_init();
        __OwnerPausable_init();

        token = settlementTokenArg;
    }

    function setBorrower(address borrowerArg) external onlyOwner {
        // IF_VNC: vault is not a contract
        require(borrowerArg.isContract(), "IF_VNC");
        borrower = borrowerArg;
    }

    function borrow(uint256 amount) external {
        // IF_OV: only vault
        require(_msgSender() == borrower, "IF_OV");
        // IF_NEB: not enough balance
        require(IERC20Metadata(token).balanceOf(address(this)) >= amount, "IF_NEB");

        TransferHelper.safeTransfer(token, borrower, amount);

        emit Borrowed(borrower, amount);
    }
}
