// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import {
    SafeERC20Upgradeable,
    IERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/SafeERC20Upgradeable.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { SettlementTokenMath } from "./lib/SettlementTokenMath.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { IInsuranceFund } from "./interface/IInsuranceFund.sol";
import { IExchange } from "./interface/IExchange.sol";
import { IAccountBalance } from "./interface/IAccountBalance.sol";
import { IClearingHouseConfig } from "./interface/IClearingHouseConfig.sol";
import { IClearingHouse } from "./interface/IClearingHouse.sol";
import { BaseRelayRecipient } from "./gsn/BaseRelayRecipient.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { VaultStorageV1 } from "./storage/VaultStorage.sol";
import { IVault } from "./interface/IVault.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract Vault is IVault, ReentrancyGuardUpgradeable, OwnerPausable, BaseRelayRecipient, VaultStorageV1 {
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
    // MODIFIER
    //

    modifier onlySettlementToken(address token) {
        // only settlement token
        require(_settlementToken == token, "V_OST");
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
        address settlementTokenArg = IInsuranceFund(insuranceFundArg).getToken();
        uint8 decimalsArg = IERC20Metadata(settlementTokenArg).decimals();

        // invalid settlementToken decimals
        require(decimalsArg <= 18, "V_ISTD");
        // ClearingHouseConfig address is not contract
        require(clearingHouseConfigArg.isContract(), "V_CHCNC");
        // accountBalance address is not contract
        require(accountBalanceArg.isContract(), "V_ABNC");
        // exchange address is not contract
        require(exchangeArg.isContract(), "V_ENC");

        __ReentrancyGuard_init();
        __OwnerPausable_init();

        // update states
        _decimals = decimalsArg;
        _settlementToken = settlementTokenArg;
        _insuranceFund = insuranceFundArg;
        _clearingHouseConfig = clearingHouseConfigArg;
        _accountBalance = accountBalanceArg;
        _exchange = exchangeArg;
    }

    function setTrustedForwarder(address trustedForwarderArg) external onlyOwner {
        // V_TFNC: TrustedForwarder address is not contract
        require(trustedForwarderArg.isContract(), "V_TFNC");
        _setTrustedForwarder(trustedForwarderArg);
    }

    function setClearingHouse(address clearingHouseArg) external onlyOwner {
        // V_CHNC: ClearingHouse is not contract
        require(clearingHouseArg.isContract(), "V_CHNC");
        _clearingHouse = clearingHouseArg;
    }

    /// @inheritdoc IVault
    function deposit(address token, uint256 amountX10_D)
        external
        override
        whenNotPaused
        nonReentrant
        onlySettlementToken(token)
    {
        // input requirement checks:
        //   token: here
        //   amountX10_D: here
        address from = _msgSender();
        _modifyBalance(from, token, amountX10_D.toInt256());

        // check for deflationary tokens by assuring balances before and after transferring to be the same
        uint256 balanceBefore = IERC20Metadata(token).balanceOf(address(this));
        SafeERC20Upgradeable.safeTransferFrom(IERC20Upgradeable(token), from, address(this), amountX10_D);
        // V_BAI: inconsistent balance amount, to prevent from deflationary tokens
        require((IERC20Metadata(token).balanceOf(address(this)).sub(balanceBefore)) == amountX10_D, "V_IBA");

        uint256 settlementTokenBalanceCap = IClearingHouseConfig(_clearingHouseConfig).getSettlementTokenBalanceCap();
        // V_GTSTBC: greater than settlement token balance cap
        require(IERC20Metadata(token).balanceOf(address(this)) <= settlementTokenBalanceCap, "V_GTSTBC");

        emit Deposited(token, from, amountX10_D);
    }

    /// @inheritdoc IVault
    function withdraw(address token, uint256 amountX10_D)
        external
        override
        whenNotPaused
        nonReentrant
        onlySettlementToken(token)
    {
        // input requirement checks:
        //   token: here
        //   amountX10_D: here

        // the full process of withdrawal:
        // 1. settle funding payment to owedRealizedPnl
        // 2. collect fee to owedRealizedPnl
        // 3. call Vault.withdraw(token, amount)
        // 4. settle pnl to trader balance in Vault
        // 5. transfer the amount to trader

        address to = _msgSender();

        // settle all funding payments owedRealizedPnl
        // pending fee can be withdraw but won't be settled
        IClearingHouse(_clearingHouse).settleAllFunding(to);

        // settle owedRealizedPnl in AccountBalance
        int256 owedRealizedPnlX10_18 = IAccountBalance(_accountBalance).settleOwedRealizedPnl(to);

        // by this time there should be no owedRealizedPnl nor pending funding payment in free collateral
        int256 freeCollateralByImRatioX10_D =
            getFreeCollateralByRatio(to, IClearingHouseConfig(_clearingHouseConfig).getImRatio());
        // V_NEFC: not enough freeCollateral
        require(
            freeCollateralByImRatioX10_D.add(owedRealizedPnlX10_18.formatSettlementToken(_decimals)) >=
                amountX10_D.toInt256(),
            "V_NEFC"
        );

        // borrow settlement token from insurance fund if the token balance in Vault is not enough
        uint256 vaultBalanceX10_D = IERC20Metadata(token).balanceOf(address(this));
        if (vaultBalanceX10_D < amountX10_D) {
            uint256 borrowedAmountX10_D = amountX10_D - vaultBalanceX10_D;
            IInsuranceFund(_insuranceFund).borrow(borrowedAmountX10_D);
            _totalDebt += borrowedAmountX10_D;
        }

        // settle withdrawn amount and owedRealizedPnl to collateral
        _modifyBalance(
            to,
            token,
            (amountX10_D.toInt256().sub(owedRealizedPnlX10_18.formatSettlementToken(_decimals))).neg256()
        );
        SafeERC20Upgradeable.safeTransfer(IERC20Upgradeable(token), to, amountX10_D);

        emit Withdrawn(token, to, amountX10_D);
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc IVault
    function getSettlementToken() external view override returns (address) {
        return _settlementToken;
    }

    /// @inheritdoc IVault
    function decimals() external view override returns (uint8) {
        return _decimals;
    }

    /// @inheritdoc IVault
    function getTotalDebt() external view override returns (uint256) {
        return _totalDebt;
    }

    /// @inheritdoc IVault
    function getClearingHouseConfig() external view override returns (address) {
        return _clearingHouseConfig;
    }

    /// @inheritdoc IVault
    function getAccountBalance() external view override returns (address) {
        return _accountBalance;
    }

    /// @inheritdoc IVault
    function getInsuranceFund() external view override returns (address) {
        return _insuranceFund;
    }

    /// @inheritdoc IVault
    function getExchange() external view override returns (address) {
        return _exchange;
    }

    /// @inheritdoc IVault
    function getClearingHouse() external view override returns (address) {
        return _clearingHouse;
    }

    /// @inheritdoc IVault
    function getFreeCollateral(address trader) external view override returns (uint256) {
        return
            PerpMath
                .max(getFreeCollateralByRatio(trader, IClearingHouseConfig(_clearingHouseConfig).getImRatio()), 0)
                .toUint256();
    }

    //
    // PUBLIC VIEW
    //

    function getBalance(address trader) public view override returns (int256) {
        return _balance[trader][_settlementToken];
    }

    function getAccountValueAndTotalCollateralValue(address trader) public view override returns (int256, int256) {
        return _getAccountValueAndTotalCollateralValue(trader);
    }

    /// @inheritdoc IVault
    function getFreeCollateralByRatio(address trader, uint24 ratio) public view override returns (int256) {
        (int256 accountValueX10_D, int256 totalCollateralValueX10_D) = _getAccountValueAndTotalCollateralValue(trader);
        uint256 totalMarginRequirementX10_18 = _getTotalMarginRequirement(trader, ratio);

        return
            PerpMath.min(totalCollateralValueX10_D, accountValueX10_D).sub(
                totalMarginRequirementX10_18.toInt256().formatSettlementToken(_decimals)
            );

        // moderate config: freeCollateral = min(collateral, accountValue - imReq)
        // return PerpMath.min(collateralValue, accountValue.subS(totalImReq.formatSettlementToken(_decimals));

        // aggressive config: freeCollateral = accountValue - imReq
        // note that the aggressive model depends entirely on unrealizedPnl, which depends on the index price
        //      we should implement some sort of safety check before using this model; otherwise,
        //      a trader could drain the entire vault if the index price deviates significantly.
        // return accountValue.subS(totalImReq.formatSettlementToken(_decimals));
    }

    //
    // INTERNAL NON-VIEW
    //

    /// @param amount can be 0; do not require this
    function _modifyBalance(
        address trader,
        address token,
        int256 amount
    ) internal {
        _balance[trader][token] = _balance[trader][token].add(amount);
    }

    //
    // INTERNAL VIEW
    //

    function _getAccountValueAndTotalCollateralValue(address trader)
        internal
        view
        returns (int256 accountValueX10_D, int256 totalCollateralValueX10_D)
    {
        // conservative config: freeCollateral = min(collateral, accountValue) - margin requirement ratio
        int256 fundingPaymentX10_18 = IExchange(_exchange).getAllPendingFundingPayment(trader);
        (int256 owedRealizedPnlX10_18, int256 unrealizedPnlX10_18, uint256 pendingFeeX10_18) =
            IAccountBalance(_accountBalance).getPnlAndPendingFee(trader);
        totalCollateralValueX10_D = getBalance(trader).add(
            owedRealizedPnlX10_18.sub(fundingPaymentX10_18).add(pendingFeeX10_18.toInt256()).formatSettlementToken(
                _decimals
            )
        );

        // accountValue = totalCollateralValue + totalUnrealizedPnl, in the settlement token's decimals
        accountValueX10_D = totalCollateralValueX10_D.add(unrealizedPnlX10_18.formatSettlementToken(_decimals));
    }

    /// @return totalMarginRequirement with decimals == 18, for freeCollateral calculation
    function _getTotalMarginRequirement(address trader, uint24 ratio) internal view returns (uint256) {
        uint256 totalDebtValue = IAccountBalance(_accountBalance).getTotalDebtValue(trader);
        return totalDebtValue.mulRatio(ratio);
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
