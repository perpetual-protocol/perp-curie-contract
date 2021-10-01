// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/MathUpgradeable.sol";
import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { ContextUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { SettlementTokenMath } from "./lib/SettlementTokenMath.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { ISettlement } from "./interface/ISettlement.sol";
import { IInsuranceFund } from "./interface/IInsuranceFund.sol";
import { IExchange } from "./interface/IExchange.sol";
import { IAccountBalance } from "./interface/IAccountBalance.sol";
import { IClearingHouseConfig } from "./interface/IClearingHouseConfig.sol";
import { BaseRelayRecipient } from "./gsn/BaseRelayRecipient.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { VaultStorageV1 } from "./storage/VaultStorage.sol";

contract Vault is ReentrancyGuardUpgradeable, OwnerPausable, BaseRelayRecipient, VaultStorageV1 {
    using SafeMathUpgradeable for uint256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;
    using SignedSafeMathUpgradeable for int256;
    using SettlementTokenMath for uint256;
    using SettlementTokenMath for int256;
    using PerpMath for int256;
    using PerpMath for uint256;
    using AddressUpgradeable for address;
    //
    // EVENT
    //

    event Deposited(address indexed collateralToken, address indexed trader, uint256 amount);
    event Withdrawn(address indexed collateralToken, address indexed trader, uint256 amount);

    //
    // MODIFIER
    //
    modifier onlySettlementToken(address token) {
        // only settlement token
        require(settlementToken == token, "V_OST");
        _;
    }

    //
    // EXTERNAL NON-VIEW
    //

    function initialize(
        address insuranceFundArg,
        address clearingHouseConfigArg,
        address accountBalanceArg,
        address exchangeArg
    ) external initializer {
        address settlementTokenArg = IInsuranceFund(insuranceFundArg).token();
        uint8 decimalsArg = IERC20Metadata(settlementTokenArg).decimals();

        // invalid settlementToken decimals
        require(decimalsArg <= 18, "V_ISTD");
        // ClearingHouseConfig address is not contract
        require(clearingHouseConfigArg.isContract(), "V_CHCNC");
        // accountBalance address is not contract
        require(accountBalanceArg.isContract(), "V_ABNC");

        __ReentrancyGuard_init();
        __OwnerPausable_init();

        // update states
        decimals = decimalsArg;
        settlementToken = settlementTokenArg;
        insuranceFund = insuranceFundArg;
        clearingHouseConfig = clearingHouseConfigArg;
        accountBalance = accountBalanceArg;
        exchange = exchangeArg;

        // we don't use this var
        versionRecipient = "2.0.0";
    }

    function setTrustedForwarder(address trustedForwarderArg) external onlyOwner {
        // V_ANC: TrustedForwarder address is not contract
        require(trustedForwarderArg.isContract(), "V_ANC");
        _setTrustedForwarder(trustedForwarderArg);
    }

    /// @param token The address of the token sender is going to deposit
    /// @param amount The amount of the token sender is going to deposit
    /// @dev The token can be other than settlementToken once multi collateral feature is implemented
    function deposit(address token, uint256 amount) external whenNotPaused nonReentrant onlySettlementToken(token) {
        address from = _msgSender();

        _modifyBalance(from, token, amount.toInt256());

        // for deflationary token,
        // amount may not be equal to the received amount due to the charged (and burned) transaction fee
        uint256 balanceBefore = IERC20Metadata(token).balanceOf(from);
        TransferHelper.safeTransferFrom(token, from, address(this), amount);
        // balance amount inconsistent
        require(balanceBefore.sub(IERC20Metadata(token).balanceOf(from)) == amount, "V_BAI");

        emit Deposited(token, from, amount);
    }

    /// @param token The address of the token sender is going to withdraw
    /// @param amount The amount of the token sender is going to withdraw
    /// @dev The token can be other than settlementToken once multi collateral feature is implemented
    function withdraw(address token, uint256 amount) external whenNotPaused nonReentrant onlySettlementToken(token) {
        address to = _msgSender();

        // the full process of a trader's withdrawal:
        //     settle funding payment to owedRealizedPnl
        //     collect fee to owedRealizedPnl
        // call Vault.withdraw(token, amount)
        //     settle pnl to trader balance in Vault
        //     transfer amount to trader

        // make sure funding payments are always settled,
        // while fees are ok to let maker decides whether to collect using CH.removeLiquidity(0)
        IExchange(exchange).settleAllFunding(to);
        int256 pnl = IAccountBalance(accountBalance).settle(to);
        // V_NEFC: not enough freeCollateral
        require(getFreeCollateral(to).toInt256().add(pnl) >= amount.toInt256(), "V_NEFC");

        // borrow settlement token from insurance fund if token balance is not enough
        uint256 vaultBalance = IERC20Metadata(token).balanceOf(address(this));
        if (vaultBalance < amount) {
            uint256 borrowAmount = amount - vaultBalance;
            IInsuranceFund(insuranceFund).borrow(borrowAmount);
            totalDebt += borrowAmount;
        }

        // settle IAccountBalance's owedRealizedPnl to collateral
        _modifyBalance(to, token, pnl.sub(amount.toInt256()));
        TransferHelper.safeTransfer(token, to, amount);

        emit Withdrawn(token, to, amount);
    }

    //
    // PUBLIC VIEW
    //

    /// @param trader The address of the trader to query
    /// @return freeCollateral Max(0, amount of collateral available for withdraw or opening new positions or orders)
    function getFreeCollateral(address trader) public view returns (uint256) {
        return
            PerpMath
                .max(getFreeCollateralByRatio(trader, IClearingHouseConfig(clearingHouseConfig).imRatio()), 0)
                .toUint256();
    }

    function balanceOf(address trader) public view override returns (int256) {
        return _getBalance(trader, settlementToken);
    }

    /// @param trader The address of the trader to query
    /// @param ratio The margin requirement ratio
    /// @dev there are three configurations for different insolvency risk tolerance: conservative, moderate, aggressive
    /// we will start with the conservative one, then gradually change it to more aggressive ones
    /// to increase capital efficiency.
    function getFreeCollateralByRatio(address trader, uint24 ratio) public view override returns (int256) {
        // conservative config: freeCollateral = max(min(collateral, accountValue) - imReq, 0)
        int256 fundingPayment = IExchange(exchange).getAllPendingFundingPayment(trader);
        (int256 owedRealizedPnl, int256 unrealizedPnl) =
            IAccountBalance(accountBalance).getOwedAndUnrealizedPnl(trader);
        int256 totalCollateralValue = balanceOf(trader).addS(owedRealizedPnl.sub(fundingPayment), decimals);

        // accountValue = totalCollateralValue + totalUnrealizedPnl, in the settlement token's decimals
        int256 accountValue = totalCollateralValue.addS(unrealizedPnl, decimals);
        uint256 totalMarginRequirement = _getTotalMarginRequirement(trader, ratio);
        return PerpMath.min(totalCollateralValue, accountValue).subS(totalMarginRequirement.toInt256(), decimals);

        // moderate config: freeCollateral = max(min(collateral, accountValue - imReq), 0)
        // return PerpMath.max(PerpMath.min(collateralValue, accountValue.subS(totalImReq, decimals)), 0).toUint256();

        // aggressive config: freeCollateral = max(accountValue - imReq, 0)
        // TODO note that aggressive model depends entirely on unrealizedPnl, which depends on the index price, for
        //  calculating freeCollateral. We should implement some sort of safety check before using this model;
        //  otherwise a trader could drain the entire vault if the index price deviates significantly.
        // return PerpMath.max(accountValue.subS(totalImReq, decimals), 0).toUint256()
    }

    //
    // INTERNAL NON-VIEW
    //

    function _modifyBalance(
        address trader,
        address token,
        int256 amount
    ) internal {
        _balance[trader][token] = _getBalance(trader, token).add(amount);
    }

    //
    // INTERNAL VIEW
    //

    /// @return totalMarginRequirement with decimals == 18
    function _getTotalMarginRequirement(address trader, uint24 ratio) internal view returns (uint256) {
        uint256 totalDebtValue = IAccountBalance(accountBalance).getTotalDebtValue(trader);
        return totalDebtValue.mulRatio(ratio);
    }

    function _getBalance(address trader, address token) internal view returns (int256) {
        return _balance[trader][token];
    }

    /// @inheritdoc BaseRelayRecipient
    function _msgSender() internal view override(BaseRelayRecipient, OwnerPausable) returns (address payable) {
        return super._msgSender();
    }

    /// @inheritdoc BaseRelayRecipient
    function _msgData() internal view override(BaseRelayRecipient, OwnerPausable) returns (bytes memory) {
        return super._msgData();
    }
}
