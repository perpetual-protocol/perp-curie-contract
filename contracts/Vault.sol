// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { SettlementTokenMath } from "./lib/SettlementTokenMath.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { IInsuranceFund } from "./interface/IInsuranceFund.sol";
import { IExchange } from "./interface/IExchange.sol";
import { IAccountBalance } from "./interface/IAccountBalance.sol";
import { IClearingHouseConfig } from "./interface/IClearingHouseConfig.sol";
import { BaseRelayRecipient } from "./gsn/BaseRelayRecipient.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { VaultStorageV1 } from "./storage/VaultStorage.sol";
import { IVault } from "./interface/IVault.sol";
import "hardhat/console.sol";
import "./AccountBalance.sol";

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
    // EVENT
    //

    event Deposited(address indexed collateralToken, address indexed trader, uint256 amount);
    event Withdrawn(address indexed collateralToken, address indexed trader, uint256 amount);

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

        // we don't use this var
        _versionRecipient = "2.0.0";
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

        uint256 settlementTokenBalanceCap = IClearingHouseConfig(_clearingHouseConfig).getSettlementTokenBalanceCap();
        if (settlementTokenBalanceCap > 0) {
            // greater than settlement token balance cap
            require(IERC20Metadata(token).balanceOf(address(this)) <= settlementTokenBalanceCap, "V_GTSTBC");
        }

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

        // settle funding payments to owedRealizedPnl,
        // while fees are ok to let maker decides whether to collect using CH.removeLiquidity(0)
        //        console.log("withdrawAmount:", amount);
        IExchange(_exchange).settleAllFunding(to);

        // owedRealizedPnl must settle first so that the numbers would match without precision errors when
        // we update collateral balance and transfer tokens.
        // In addition, it should be settled in the same way as it is used in calculating free collateral,
        // so the settled freeCollateral remain the same.
        _settleOwedRealizedPnl(to, token);

        // by this time free collateral should see zero funding payment and zero owedRealizedPnl
        int256 freeCollateralByImRatio =
            getFreeCollateralByRatio(to, IClearingHouseConfig(_clearingHouseConfig).getImRatio());
        //        console.log("freeCollateralByImRatio:");
        //        console.logInt(freeCollateralByImRatio);
        // V_NEFC: not enough freeCollateral
        require(freeCollateralByImRatio >= amount.toInt256(), "V_NEFC");

        // borrow settlement token from insurance fund if token balance is not enough
        uint256 vaultBalance = IERC20Metadata(token).balanceOf(address(this));
        if (vaultBalance < amount) {
            uint256 borrowAmount = amount - vaultBalance;
            IInsuranceFund(_insuranceFund).borrow(borrowAmount);
            _totalDebt += borrowAmount;
        }

        // settle withdraw amount to collateral balance
        _modifyBalance(to, token, -(amount.toInt256()));
        TransferHelper.safeTransfer(token, to, amount);

        emit Withdrawn(token, to, amount);
    }

    //
    // PUBLIC VIEW
    //

    /// @inheritdoc IVault
    function getSettlementToken() external view override returns (address) {
        return _settlementToken;
    }

    /// @inheritdoc IVault
    /// @dev cached the settlement token's decimal for gas optimization
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

    /// @param trader The address of the trader to query
    /// @return freeCollateral Max(0, amount of collateral available for withdraw or opening new positions or orders)
    function getFreeCollateral(address trader) external view returns (uint256) {
        return
            PerpMath
                .max(getFreeCollateralByRatio(trader, IClearingHouseConfig(_clearingHouseConfig).getImRatio()), 0)
                .toUint256();
    }

    function balanceOf(address trader) public view override returns (int256) {
        return _getBalance(trader, _settlementToken);
    }

    /// @param trader The address of the trader to query
    /// @param ratio The margin requirement ratio
    /// @dev there are three configurations for different insolvency risk tolerance: conservative, moderate, aggressive
    /// we will start with the conservative one, then gradually change it to more aggressive ones
    /// to increase capital efficiency.
    function getFreeCollateralByRatio(address trader, uint24 ratio) public view override returns (int256) {
        //        console.log("vault.balanceOf (before):");
        //        console.logInt(balanceOf(trader));
        // conservative config: freeCollateral = min(collateral, accountValue) - imReq, freeCollateral could be negative
        int256 fundingPayment = IExchange(_exchange).getAllPendingFundingPayment(trader);
        (int256 owedRealizedPnl, int256 unrealizedPnl) =
            IAccountBalance(_accountBalance).getOwedAndUnrealizedPnl(trader);
        //        console.log("owedRealizedPnl:");
        //        console.logInt(owedRealizedPnl);
        //        console.log("unrealizedPnl:");
        //        console.logInt(unrealizedPnl);
        //        console.log("vault.balanceOf:");
        //        console.logInt(balanceOf(trader));
        int256 totalCollateralValue = balanceOf(trader).addS(owedRealizedPnl.sub(fundingPayment), _decimals);
        //        console.log("totalCollateralValue:");
        //        console.logInt(totalCollateralValue);

        // accountValue = totalCollateralValue + totalUnrealizedPnl, in the settlement token's decimals
        int256 accountValue = totalCollateralValue.addS(unrealizedPnl, _decimals);
        //        console.log("accountValue:");
        //        console.logInt(accountValue);
        uint256 totalMarginRequirement = _getTotalMarginRequirement(trader, ratio);
        //        console.log("totalMarginRequirement:", totalMarginRequirement);
        return PerpMath.min(totalCollateralValue, accountValue).subS(totalMarginRequirement.toInt256(), _decimals);

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

    function _settleOwedRealizedPnl(address trader, address token) internal {
        // settle owedRealizedPnl in AccountBalance
        int256 owedRealizedPnlIn10_18 = IAccountBalance(_accountBalance).settle(trader);
        //        console.log("owedRealizedPnlIn10_18:");
        //        console.logInt(owedRealizedPnlIn10_18);
        // settle owedRealizedPnl to collateral balance
        // note we can't use _modifyBalance() here due to decimal difference
        _balance[trader][token] = _getBalance(trader, token).addS(owedRealizedPnlIn10_18, _decimals);
    }

    //
    // INTERNAL VIEW
    //

    /// @return totalMarginRequirement with decimals == 18
    function _getTotalMarginRequirement(address trader, uint24 ratio) internal view returns (uint256) {
        uint256 totalDebtValue = IAccountBalance(_accountBalance).getTotalDebtValue(trader);
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
