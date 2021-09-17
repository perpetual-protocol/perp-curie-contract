// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IInsuranceFund } from "./interface/IInsuranceFund.sol";

contract InsuranceFund is IInsuranceFund, ReentrancyGuardUpgradeable, OwnerPausable {
    using AddressUpgradeable for address;

    address public borrower;
    address public override token;

    event Borrowed(address borrower, uint256 amount);

    function initialize(address tokenArg) external initializer {
        // token address is not contract
        require(tokenArg.isContract(), "IF_STNC");

        __ReentrancyGuard_init();
        __OwnerPausable_init();

        token = tokenArg;
    }

    function setBorrower(address borrowerArg) external onlyOwner {
        // borrower is not a contract
        require(borrowerArg.isContract(), "IF_BNC");
        borrower = borrowerArg;
    }

    function borrow(uint256 amount) external override nonReentrant whenNotPaused {
        // only borrower
        require(_msgSender() == borrower, "IF_OB");
        // not enough balance
        require(IERC20Upgradeable(token).balanceOf(address(this)) >= amount, "IF_NEB");

        TransferHelper.safeTransfer(token, borrower, amount);

        emit Borrowed(borrower, amount);
    }
}
