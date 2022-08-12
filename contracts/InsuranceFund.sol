// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/SafeERC20Upgradeable.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { InsuranceFundStorageV1 } from "./storage/InsuranceFundStorage.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { IInsuranceFund } from "./interface/IInsuranceFund.sol";
import { IVault } from "./interface/IVault.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract InsuranceFund is IInsuranceFund, ReentrancyGuardUpgradeable, OwnerPausable, InsuranceFundStorageV1 {
    using AddressUpgradeable for address;
    using SignedSafeMathUpgradeable for int256;
    using PerpMath for int256;
    using PerpSafeCast for uint256;

    function initialize(address tokenArg) external initializer {
        // token address is not contract
        require(tokenArg.isContract(), "IF_TNC");

        __ReentrancyGuard_init();
        __OwnerPausable_init();

        _token = tokenArg;
    }

    function setBorrower(address borrowerArg) external onlyOwner {
        // borrower is not a contract
        require(borrowerArg.isContract(), "IF_BNC");
        _borrower = borrowerArg;
        emit BorrowerChanged(borrowerArg);
    }

    /// @inheritdoc IInsuranceFund
    function repay() external override nonReentrant whenNotPaused {
        address vault = _borrower;
        address token = _token;

        int256 accountValue = IVault(vault).getAccountValue(address(this));

        // IF_RWN: repay when negative
        require(accountValue < 0, "IF_RWN");

        uint256 tokenBalance = IERC20Upgradeable(token).balanceOf(address(this));
        uint256 repaidAmount = tokenBalance >= accountValue.abs() ? accountValue.abs() : tokenBalance;

        IERC20Upgradeable(token).approve(vault, repaidAmount);
        IVault(vault).deposit(token, repaidAmount);

        uint256 tokenBalanceAfterRepaid = IERC20Upgradeable(token).balanceOf(address(this));

        emit Repaid(repaidAmount, tokenBalanceAfterRepaid);
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc IInsuranceFund
    function getToken() external view override returns (address) {
        return _token;
    }

    /// @inheritdoc IInsuranceFund
    function getBorrower() external view override returns (address) {
        return _borrower;
    }

    //
    // PUBLIC VIEW
    //

    /// @inheritdoc IInsuranceFund
    function getInsuranceFundCapacity() public view override returns (int256) {
        address vault = _borrower;
        address token = _token;

        int256 insuranceFundAccountValueX10_S = IVault(vault).getAccountValue(address(this));
        int256 insuranceFundWalletBalanceX10_S = IERC20Upgradeable(token).balanceOf(address(this)).toInt256();
        int256 insuranceFundCapacityX10_S = insuranceFundAccountValueX10_S.add(insuranceFundWalletBalanceX10_S);

        return insuranceFundCapacityX10_S;
    }
}
