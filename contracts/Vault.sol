// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/MathUpgradeable.sol";
import {
    SafeERC20Upgradeable,
    IERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/SafeERC20Upgradeable.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { TransferHelper } from "@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol";
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
import { VaultStorageV2 } from "./storage/VaultStorage.sol";
import { Collateral } from "./lib/Collateral.sol";
import { IVault } from "./interface/IVault.sol";
import { IWETH9 } from "./interface/external/IWETH9.sol";
import { ICollateralManager } from "./interface/ICollateralManager.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract Vault is IVault, ReentrancyGuardUpgradeable, OwnerPausable, BaseRelayRecipient, VaultStorageV2 {
    using SafeMathUpgradeable for uint256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;
    using SignedSafeMathUpgradeable for int256;
    using SettlementTokenMath for uint256;
    using SettlementTokenMath for int256;
    using PerpMath for int256;
    using PerpMath for uint256;
    using PerpMath for uint24;
    using FullMath for uint256;
    using AddressUpgradeable for address;

    uint24 private constant _ONE_HUNDRED_PERCENT_RATIO = 1e6;

    //
    // MODIFIER
    //

    modifier onlySettlementOrCollateralToken(address token) {
        // V_OSCT: only settlement or collateral token
        require(token == _settlementToken || _isCollateral(token), "V_OSCT");
        _;
    }

    //
    // EXTERNAL NON-VIEW
    //

    /// @dev only used for unwrapping weth in withdrawETH
    receive() external payable {}

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
        emit TrustedForwarderChanged(trustedForwarderArg);
    }

    function setClearingHouse(address clearingHouseArg) external onlyOwner {
        // V_CHNC: ClearingHouse is not contract
        require(clearingHouseArg.isContract(), "V_CHNC");

        _clearingHouse = clearingHouseArg;
        emit ClearingHouseChanged(clearingHouseArg);
    }

    function setCollateralManager(address collateralManagerArg) external onlyOwner {
        // V_CMNC: CollateralManager is not contract
        require(collateralManagerArg.isContract(), "V_CMNC");

        _collateralManager = collateralManagerArg;
        emit CollateralManagerChanged(collateralManagerArg);
    }

    function setWETH9(address WETH9Arg) external onlyOwner {
        // V_WNC: WETH9 is not contract
        require(WETH9Arg.isContract(), "V_WNC");

        _WETH9 = WETH9Arg;
        emit WETH9Changed(WETH9Arg);
    }

    /// @inheritdoc IVault
    function deposit(address token, uint256 amount)
        external
        override
        whenNotPaused
        nonReentrant
        onlySettlementOrCollateralToken(token)
    {
        // input requirement checks:
        //   token: here
        //   amount: here

        address from = _msgSender();
        _deposit(from, from, token, amount);
    }

    /// @inheritdoc IVault
    function depositFor(
        address to,
        address token,
        uint256 amount
    ) external override whenNotPaused nonReentrant onlySettlementOrCollateralToken(token) {
        // input requirement checks:
        //   token: here
        //   amount: _deposit

        // V_DFZA: Deposit for zero address
        require(to != address(0), "V_DFZA");

        address from = _msgSender();
        _deposit(from, to, token, amount);
    }

    /// @inheritdoc IVault
    function depositEther() external payable override whenNotPaused nonReentrant {
        address to = _msgSender();
        _depositEther(to);
    }

    /// @inheritdoc IVault
    function depositEtherFor(address to) external payable override whenNotPaused nonReentrant {
        // V_DFZA: Deposit for zero address
        require(to != address(0), "V_DFZA");
        _depositEther(to);
    }

    /// @inheritdoc IVault
    // the full process of withdrawal:
    // 1. settle funding payment to owedRealizedPnl
    // 2. collect fee to owedRealizedPnl
    // 3. call Vault.withdraw(token, amount)
    // 4. settle pnl to trader balance in Vault
    // 5. transfer the amount to trader
    function withdraw(address token, uint256 amount)
        external
        override
        whenNotPaused
        nonReentrant
        onlySettlementOrCollateralToken(token)
    {
        // input requirement checks:
        //   token: here
        //   amount: here

        address to = _msgSender();
        _settleAndDecreaseBalance(to, token, amount);
        SafeERC20Upgradeable.safeTransfer(IERC20Upgradeable(token), to, amount);
        emit Withdrawn(token, to, amount);
    }

    /// @inheritdoc IVault
    function withdrawEther(uint256 amount) external override whenNotPaused nonReentrant {
        _requireWETH9IsCollateral();

        address to = _msgSender();
        // SLOAD for gas saving
        address WETH9 = _WETH9;
        _settleAndDecreaseBalance(to, WETH9, amount);

        IWETH9(WETH9).withdraw(amount);
        TransferHelper.safeTransferETH(to, amount);
        emit Withdrawn(WETH9, to, amount);
    }

    /// @inheritdoc IVault
    function liquidateCollateral(
        address trader,
        address token,
        uint256 amount,
        bool isDenominatedInSettlementToken
    ) external override whenNotPaused nonReentrant returns (uint256) {
        // V_NL: Not liquidatable
        require(isLiquidatable(trader), "V_NL");

        (uint256 maxRepaidSettlementX10_S, uint256 maxLiquidatableCollateral) =
            getMaxRepaidSettlementAndLiquidatableCollateral(trader, token);

        uint256 collateral;
        uint256 settlementX10_S;
        uint256 returnAmount;

        if (isDenominatedInSettlementToken) {
            settlementX10_S = amount;
            // V_MSAE: Maximum settlement amount exceeded
            require(settlementX10_S <= maxRepaidSettlementX10_S, "V_MSAE");
            collateral = settlementX10_S == maxRepaidSettlementX10_S
                ? maxLiquidatableCollateral
                : getLiquidatableCollateralBySettlement(token, settlementX10_S);
            returnAmount = collateral;
        } else {
            collateral = amount;
            // V_MCAE: Maximum collateral amount exceeded
            require(collateral <= maxLiquidatableCollateral, "V_MCAE");
            settlementX10_S = collateral == maxLiquidatableCollateral
                ? maxRepaidSettlementX10_S
                : getRepaidSettlementByCollateral(token, collateral);
            returnAmount = settlementX10_S;
        }

        _liquidateCollateral(trader, token, settlementX10_S, collateral);

        return returnAmount;
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
    function getCollateralManager() external view override returns (address) {
        return _collateralManager;
    }

    /// @inheritdoc IVault
    function getWETH9() external view override returns (address) {
        return _WETH9;
    }

    //
    // PUBLIC VIEW
    //

    /// @inheritdoc IVault
    function getBalance(address trader) public view override returns (int256) {
        return _balance[trader][_settlementToken];
    }

    /// @inheritdoc IVault
    function getBalanceByToken(address trader, address token) public view override returns (int256) {
        return _balance[trader][token];
    }

    /// @inheritdoc IVault
    function getCollateralTokens(address trader) external view override returns (address[] memory) {
        return _collateralTokensMap[trader];
    }

    /// @inheritdoc IVault
    function getAccountValue(address trader) public view override returns (int256) {
        (int256 accountValueX10_S, ) = _getAccountValueAndTotalCollateralValue(trader);
        return accountValueX10_S;
    }

    /// @inheritdoc IVault
    function getFreeCollateral(address trader) public view override returns (uint256) {
        return
            PerpMath
                .max(getFreeCollateralByRatio(trader, IClearingHouseConfig(_clearingHouseConfig).getImRatio()), 0)
                .toUint256();
    }

    /// @inheritdoc IVault
    function getFreeCollateralByRatio(address trader, uint24 ratio) public view override returns (int256) {
        // conservative config: freeCollateral = min(totalCollateralValue, accountValue) - openOrderMarginReq
        (int256 accountValueX10_S, int256 totalCollateralValueX10_S) = _getAccountValueAndTotalCollateralValue(trader);
        uint256 totalMarginRequirementX10_S = _getTotalMarginRequirement(trader, ratio);

        return PerpMath.min(totalCollateralValueX10_S, accountValueX10_S).sub(totalMarginRequirementX10_S.toInt256());

        // moderate config: freeCollateral = min(totalCollateralValue, accountValue - openOrderMarginReq)
        // return
        //     PerpMath.min(
        //         totalCollateralValueX10_S,
        //         accountValueX10_S.sub(totalMarginRequirementX10_S.toInt256().formatSettlementToken(_decimals))
        //     );

        // aggressive config: freeCollateral = accountValue - openOrderMarginReq
        // note that the aggressive model depends entirely on unrealizedPnl, which depends on the index price
        //      we should implement some sort of safety check before using this model; otherwise,
        //      a trader could drain the entire vault if the index price deviates significantly.
        // return accountValueX10_S.sub(totalMarginRequirementX10_S.toInt256().formatSettlementToken(_decimals));
    }

    /// @inheritdoc IVault
    // getFreeCollateralByToken(token) = (getSettlementTokenValue() >= 0)
    //   ? min(getFreeCollateral() / indexPrice[token], getBalanceByToken(token))
    //   : 0
    function getFreeCollateralByToken(address trader, address token) public view override returns (uint256) {
        // do not check settlementTokenValue == 0 because user's settlement token balance may be zero
        if (getSettlementTokenValue(trader) < 0) {
            return 0;
        }

        uint256 freeCollateral = getFreeCollateral(trader);
        if (freeCollateral == 0) {
            return 0;
        }

        if (token == _settlementToken) {
            (int256 settlementTokenBalance, ) = _getSettlementTokenBalanceAndUnrealizedPnl(trader);
            // note that settlement token balance (incl. fee, funding payment, realized PnL) could be negative
            return
                settlementTokenBalance <= 0
                    ? 0
                    : MathUpgradeable.min(freeCollateral, settlementTokenBalance.toUint256());
        }

        (uint256 indexTwap, uint8 priceFeedDecimals) = _getIndexPriceAndDecimals(token);
        uint24 collateralRatio = ICollateralManager(_collateralManager).getCollateralConfig(token).collateralRatio;
        return
            MathUpgradeable.min(
                _getCollateralBySettlement(token, freeCollateral, indexTwap, priceFeedDecimals).divRatio(
                    collateralRatio
                ),
                // non-settlement token is always positive number
                getBalanceByToken(trader, token).toUint256()
            );
    }

    /// @inheritdoc IVault
    function getSettlementTokenValue(address trader) public view override returns (int256) {
        (int256 settlementBalanceX10_S, int256 unrealizedPnlX10_S) = _getSettlementTokenBalanceAndUnrealizedPnl(trader);
        // settlementTokenValue = settlementTokenBalance + totalUnrealizedPnl, in the settlement token's decimals
        return settlementBalanceX10_S.add(unrealizedPnlX10_S);
    }

    /// @inheritdoc IVault
    function isLiquidatable(address trader) public view override returns (bool) {
        address[] storage collateralTokens = _collateralTokensMap[trader];
        if (collateralTokens.length == 0) {
            return false;
        }

        if (
            getAccountValue(trader).parseSettlementToken(_decimals) <
            getMarginRequirementForCollateralLiquidation(trader)
        ) {
            return true;
        }

        int256 settlementTokenValueX10_S = getSettlementTokenValue(trader);
        uint256 settlementTokenDebtX10_S =
            settlementTokenValueX10_S < 0 ? settlementTokenValueX10_S.neg256().toUint256() : 0;

        if (
            settlementTokenDebtX10_S >
            _getNonSettlementTokenValue(trader).mulRatio(
                ICollateralManager(_collateralManager).getDebtNonSettlementTokenValueRatio()
            )
        ) {
            return true;
        }

        if (settlementTokenDebtX10_S > ICollateralManager(_collateralManager).getDebtThreshold()) {
            return true;
        }

        return false;
    }

    /// @inheritdoc IVault
    function getMarginRequirementForCollateralLiquidation(address trader) public view override returns (int256) {
        return
            IAccountBalance(_accountBalance)
                .getTotalAbsPositionValue(trader)
                .mulRatio(getCollateralMmRatio())
                .toInt256();
    }

    /// @inheritdoc IVault
    function getCollateralMmRatio() public view override returns (uint24) {
        uint24 collateralMmRatio =
            ICollateralManager(_collateralManager).requireValidCollateralMmRatio(
                ICollateralManager(_collateralManager).getMmRatioBuffer()
            );
        return collateralMmRatio;
    }

    /// @inheritdoc IVault
    function getRepaidSettlementByCollateral(address token, uint256 collateral)
        public
        view
        override
        returns (uint256 settlementX10_S)
    {
        uint24 discountRatio = ICollateralManager(_collateralManager).getCollateralConfig(token).discountRatio;
        (uint256 indexTwap, uint8 priceFeedDecimals) = _getIndexPriceAndDecimals(token);

        return
            _getSettlementByCollateral(
                token,
                collateral,
                indexTwap.mulRatio(_ONE_HUNDRED_PERCENT_RATIO.subRatio(discountRatio)),
                priceFeedDecimals
            );
    }

    /// @inheritdoc IVault
    function getLiquidatableCollateralBySettlement(address token, uint256 settlementX10_S)
        public
        view
        override
        returns (uint256 collateral)
    {
        uint24 discountRatio = ICollateralManager(_collateralManager).getCollateralConfig(token).discountRatio;
        (uint256 indexTwap, uint8 priceFeedDecimals) = _getIndexPriceAndDecimals(token);

        return
            _getCollateralBySettlement(
                token,
                settlementX10_S,
                indexTwap.mulRatio(_ONE_HUNDRED_PERCENT_RATIO.subRatio(discountRatio)),
                priceFeedDecimals
            );
    }

    /// @inheritdoc IVault
    /// @dev formula:
    /// maxRepaidSettlement = maxLiquidatableCollateral * indexTwap
    /// maxLiquidatableCollateral =
    ///     min(maxRepaidSettlement / (indexTwap * (1 - discountRatio)), getBalanceByToken(trader, token))
    function getMaxRepaidSettlementAndLiquidatableCollateral(address trader, address token)
        public
        view
        override
        returns (uint256 maxRepaidSettlementX10_S, uint256 maxLiquidatableCollateral)
    {
        // V_TINAC: token is not a collateral
        require(_isCollateral(token), "V_TINAC");

        maxRepaidSettlementX10_S = _getMaxRepaidSettlement(trader);
        uint24 discountRatio = ICollateralManager(_collateralManager).getCollateralConfig(token).discountRatio;
        (uint256 indexTwap, uint8 priceFeedDecimals) = _getIndexPriceAndDecimals(token);

        uint256 discountedIndexTwap = indexTwap.mulRatio(_ONE_HUNDRED_PERCENT_RATIO.subRatio(discountRatio));
        maxLiquidatableCollateral = _getCollateralBySettlement(
            token,
            maxRepaidSettlementX10_S,
            discountedIndexTwap,
            priceFeedDecimals
        );

        uint256 tokenBalance = getBalanceByToken(trader, token).toUint256();
        if (maxLiquidatableCollateral > tokenBalance) {
            maxLiquidatableCollateral = tokenBalance;

            // Deliberately rounding down when calculating settlement. Thus, when calculating
            // collateral with settlement, the result is always <= maxCollateral.
            // This makes sure that collateral will always be <= user's collateral balance.
            maxRepaidSettlementX10_S = _getSettlementByCollateral(
                token,
                maxLiquidatableCollateral,
                discountedIndexTwap,
                priceFeedDecimals
            );
        }

        return (maxRepaidSettlementX10_S, maxLiquidatableCollateral);
    }

    //
    // INTERNAL NON-VIEW
    //

    /// @param token the collateral token needs to be transferred into vault
    /// @param from the address of account who owns the collateral token
    /// @param amount the amount of collateral token needs to be transferred
    function _transferTokenIn(
        address token,
        address from,
        uint256 amount
    ) internal {
        // check for deflationary tokens by assuring balances before and after transferring to be the same
        uint256 balanceBefore = IERC20Metadata(token).balanceOf(address(this));
        SafeERC20Upgradeable.safeTransferFrom(IERC20Upgradeable(token), from, address(this), amount);
        // V_IBA: inconsistent balance amount, to prevent from deflationary tokens
        require((IERC20Metadata(token).balanceOf(address(this)).sub(balanceBefore)) == amount, "V_IBA");
    }

    /// @param from deposit token from this address
    /// @param to deposit token to this address
    /// @param token the collateral token wish to deposit
    /// @param amount the amount of token to deposit
    function _deposit(
        address from,
        address to,
        address token,
        uint256 amount
    ) internal {
        // V_ZA: Zero amount
        require(amount > 0, "V_ZA");
        _transferTokenIn(token, from, amount);
        _checkDepositCapAndRegister(token, to, amount);
    }

    /// @param to deposit ETH to this address
    function _depositEther(address to) internal {
        uint256 amount = msg.value;
        // V_ZA: Zero amount
        require(amount > 0, "V_ZA");
        _requireWETH9IsCollateral();

        // SLOAD for gas saving
        address WETH9 = _WETH9;
        // wrap ETH into WETH
        IWETH9(WETH9).deposit{ value: amount }();
        _checkDepositCapAndRegister(WETH9, to, amount);
    }

    /// @param token the collateral token needs to be transferred out of vault
    /// @param to the address of account that the collateral token deposit to
    /// @param amount the amount of collateral token to be deposited
    function _checkDepositCapAndRegister(
        address token,
        address to,
        uint256 amount
    ) internal {
        if (token == _settlementToken) {
            uint256 settlementTokenBalanceCap =
                IClearingHouseConfig(_clearingHouseConfig).getSettlementTokenBalanceCap();
            // V_GTSTBC: greater than settlement token balance cap
            require(IERC20Metadata(token).balanceOf(address(this)) <= settlementTokenBalanceCap, "V_GTSTBC");
        } else {
            uint256 depositCap = ICollateralManager(_collateralManager).getCollateralConfig(token).depositCap;
            // V_GTDC: greater than deposit cap
            require(IERC20Metadata(token).balanceOf(address(this)) <= depositCap, "V_GTDC");
        }

        _modifyBalance(to, token, amount.toInt256());
        emit Deposited(token, to, amount);
    }

    function _settleAndDecreaseBalance(
        address to,
        address token,
        uint256 amount
    ) internal {
        // settle all funding payments owedRealizedPnl
        // pending fee can be withdraw but won't be settled
        IClearingHouse(_clearingHouse).settleAllFunding(to);

        // incl. owedRealizedPnl
        uint256 freeCollateral = getFreeCollateralByToken(to, token);
        // V_NEFC: not enough freeCollateral
        require(freeCollateral >= amount, "V_NEFC");

        int256 deltaBalance = amount.toInt256().neg256();
        if (token == _settlementToken) {
            // borrow settlement token from insurance fund if the token balance in Vault is not enough
            uint256 vaultBalanceX10_S = IERC20Metadata(token).balanceOf(address(this));
            if (vaultBalanceX10_S < amount) {
                uint256 borrowedAmountX10_S = amount - vaultBalanceX10_S;
                IInsuranceFund(_insuranceFund).borrow(borrowedAmountX10_S);
                _totalDebt += borrowedAmountX10_S;
            }

            // settle both the withdrawn amount and owedRealizedPnl to collateral
            int256 owedRealizedPnlX10_18 = IAccountBalance(_accountBalance).settleOwedRealizedPnl(to);
            deltaBalance = deltaBalance.add(owedRealizedPnlX10_18.formatSettlementToken(_decimals));
        }

        _modifyBalance(to, token, deltaBalance);
    }

    /// @param amount can be 0; do not require this
    function _modifyBalance(
        address trader,
        address token,
        int256 amount
    ) internal {
        int256 oldBalance = _balance[trader][token];
        int256 newBalance = oldBalance.add(amount);
        _balance[trader][token] = newBalance;

        if (token == _settlementToken) {
            return;
        }

        // register/deregister non-settlement collateral tokens
        if (oldBalance != 0 && newBalance == 0) {
            address[] storage collateralTokens = _collateralTokensMap[trader];
            uint256 tokenLen = collateralTokens.length;
            uint256 lastTokenIndex = tokenLen - 1;
            // find and deregister the token
            for (uint256 i; i < tokenLen; i++) {
                if (collateralTokens[i] == token) {
                    // delete the token by replacing it with the last one and then pop it from there
                    if (i != lastTokenIndex) {
                        collateralTokens[i] = collateralTokens[lastTokenIndex];
                    }
                    collateralTokens.pop();
                    break;
                }
            }
        } else if (oldBalance == 0 && newBalance != 0) {
            address[] storage collateralTokens = _collateralTokensMap[trader];
            collateralTokens.push(token);
            // V_CTNE: collateral tokens number exceeded
            require(
                collateralTokens.length <= ICollateralManager(_collateralManager).getMaxCollateralTokensPerAccount(),
                "V_CTNE"
            );
        }
    }

    /// @dev liquidate trader's collateral token by repaying the trader's settlement token debt
    ///      the amount of collateral token and settlement token should be calculated by using
    ///      getLiquidatableCollateralBySettlement() and getRepaidSettlementByCollateral()
    function _liquidateCollateral(
        address trader,
        address token,
        uint256 settlementX10_S,
        uint256 collateral
    ) internal {
        address liquidator = _msgSender();
        address settlementToken = _settlementToken; // SLOAD gas saving

        // transfer settlement token from liquidator before changing any internal states
        _transferTokenIn(settlementToken, liquidator, settlementX10_S);

        _modifyBalance(trader, token, collateral.neg256());

        uint24 clInsuranceFundFeeRatio = ICollateralManager(_collateralManager).getCLInsuranceFundFeeRatio();
        uint256 repaidSettlementWithoutInsuranceFundFeeX10_S =
            settlementX10_S.mulRatio(_ONE_HUNDRED_PERCENT_RATIO.subRatio(clInsuranceFundFeeRatio));
        _modifyBalance(trader, settlementToken, repaidSettlementWithoutInsuranceFundFeeX10_S.toInt256());

        uint256 insuranceFundFeeX10_S = settlementX10_S.sub(repaidSettlementWithoutInsuranceFundFeeX10_S);
        _modifyBalance(_insuranceFund, settlementToken, insuranceFundFeeX10_S.toInt256());

        // transfer collateral token from vault to liquidator
        SafeERC20Upgradeable.safeTransfer(IERC20Upgradeable(token), liquidator, collateral);

        uint24 discountRatio = ICollateralManager(_collateralManager).getCollateralConfig(token).discountRatio;

        emit CollateralLiquidated(
            trader,
            token,
            liquidator,
            collateral,
            repaidSettlementWithoutInsuranceFundFeeX10_S,
            insuranceFundFeeX10_S,
            discountRatio
        );
    }

    //
    // INTERNAL VIEW
    //

    function _getTokenDecimals(address token) internal view returns (uint8) {
        return IERC20Metadata(token).decimals();
    }

    function _getTotalCollateralValue(address trader) internal view returns (int256 totalCollateralValueX10_S) {
        (int256 settlementTokenBalanceX10_S, ) = _getSettlementTokenBalanceAndUnrealizedPnl(trader);
        uint256 nonSettlementTokenValueX10_S = _getNonSettlementTokenValue(trader);
        return nonSettlementTokenValueX10_S.toInt256().add(settlementTokenBalanceX10_S);
    }

    /// @notice Get the specified trader's settlement token balance, including pending fee, funding payment,
    ///         owed realized PnL, but without unrealized PnL)
    /// @dev Note the difference between the return argument`settlementTokenBalanceX10_S` and
    ///      the return value of `getSettlementTokenValue()`.
    ///      The first one is settlement token balance with pending fee, funding payment, owed realized PnL;
    ///      The second one is the first one plus unrealized PnL.
    /// @return settlementTokenBalanceX10_S Settlement amount with the same decimals as settlement token
    /// @return unrealizedPnlX10_S Unrealized PnL with the same decimals as settlement token
    function _getSettlementTokenBalanceAndUnrealizedPnl(address trader)
        internal
        view
        returns (int256 settlementTokenBalanceX10_S, int256 unrealizedPnlX10_S)
    {
        int256 fundingPaymentX10_18 = IExchange(_exchange).getAllPendingFundingPayment(trader);
        (int256 owedRealizedPnlX10_18, int256 unrealizedPnlX10_18, uint256 pendingFeeX10_18) =
            IAccountBalance(_accountBalance).getPnlAndPendingFee(trader);

        settlementTokenBalanceX10_S = getBalance(trader).add(
            pendingFeeX10_18.toInt256().sub(fundingPaymentX10_18).add(owedRealizedPnlX10_18).formatSettlementToken(
                _decimals
            )
        );

        return (settlementTokenBalanceX10_S, unrealizedPnlX10_18.formatSettlementToken(_decimals));
    }

    /// @return nonSettlementTokenValueX10_S total non-settlement token value,
    ///         with the same decimals as settlement token
    function _getNonSettlementTokenValue(address trader) internal view returns (uint256 nonSettlementTokenValueX10_S) {
        address[] memory collateralTokens = _collateralTokensMap[trader];
        uint256 tokenLen = collateralTokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address token = collateralTokens[i];
            uint256 collateralValueX10_S = _getCollateralValue(trader, token);
            uint24 collateralRatio = ICollateralManager(_collateralManager).getCollateralConfig(token).collateralRatio;

            nonSettlementTokenValueX10_S = nonSettlementTokenValueX10_S.add(
                collateralValueX10_S.mulRatio(collateralRatio)
            );
        }

        return nonSettlementTokenValueX10_S;
    }

    /// @return collateralValueX10_S collateral value with the same decimals as settlement token
    function _getCollateralValue(address trader, address token) internal view returns (uint256 collateralValueX10_S) {
        int256 tokenBalance = getBalanceByToken(trader, token);
        (uint256 indexTwap, uint8 priceFeedDecimals) = _getIndexPriceAndDecimals(token);
        return _getSettlementByCollateral(token, tokenBalance.toUint256(), indexTwap, priceFeedDecimals);
    }

    function _getIndexPriceAndDecimals(address token) internal view returns (uint256, uint8) {
        return (
            ICollateralManager(_collateralManager).getPrice(
                token,
                IClearingHouseConfig(_clearingHouseConfig).getTwapInterval()
            ),
            ICollateralManager(_collateralManager).getPriceFeedDecimals(token)
        );
    }

    /// @return settlementX10_S collateral value with the same decimals as settlement token
    function _getSettlementByCollateral(
        address token,
        uint256 collateral,
        uint256 price,
        uint8 priceFeedDecimals
    ) internal view returns (uint256 settlementX10_S) {
        uint8 settlementTokenDecimals = _decimals;
        uint8 collateralTokenDecimals = _getTokenDecimals(token);

        // Convert token decimals with as much precision as possible
        return
            settlementTokenDecimals < collateralTokenDecimals
                ? collateral.mulDiv(price, 10**priceFeedDecimals).convertTokenDecimals(
                    collateralTokenDecimals,
                    settlementTokenDecimals
                )
                : collateral.convertTokenDecimals(collateralTokenDecimals, settlementTokenDecimals).mulDiv(
                    price,
                    10**priceFeedDecimals
                );
    }

    /// @return collateral collateral amount
    function _getCollateralBySettlement(
        address token,
        uint256 settlementX10_S,
        uint256 price,
        uint8 priceFeedDecimals
    ) internal view returns (uint256 collateral) {
        uint8 settlementTokenDecimals = _decimals;
        uint8 collateralTokenDecimals = _getTokenDecimals(token);

        // Convert token decimals with as much precision as possible
        return
            settlementTokenDecimals < collateralTokenDecimals
                ? settlementX10_S
                    .convertTokenDecimals(settlementTokenDecimals, collateralTokenDecimals)
                    .mulDivRoundingUp(10**priceFeedDecimals, price)
                : settlementX10_S.mulDivRoundingUp(10**priceFeedDecimals, price).convertTokenDecimals(
                    settlementTokenDecimals,
                    collateralTokenDecimals
                );
    }

    function _getAccountValueAndTotalCollateralValue(address trader)
        internal
        view
        returns (int256 accountValueX10_S, int256 totalCollateralValueX10_S)
    {
        (, int256 unrealizedPnlX10_18, ) = IAccountBalance(_accountBalance).getPnlAndPendingFee(trader);

        totalCollateralValueX10_S = _getTotalCollateralValue(trader);

        // accountValue = totalCollateralValue + totalUnrealizedPnl, in the settlement token's decimals
        accountValueX10_S = totalCollateralValueX10_S.add(unrealizedPnlX10_18.formatSettlementToken(_decimals));

        return (accountValueX10_S, totalCollateralValueX10_S);
    }

    /// @notice Get the maximum value denominated in settlement token when liquidating a trader's collateral tokens
    /// @dev formula:
    ///      maxDebt = max(max(-settlementTokenValue, 0), openOrderReq)
    ///      maxRepaidSettlementWithoutInsuranceFundFee =
    ///          maxDebt > collateralValueDustThreshold ? maxDebt * liquidationRatio : maxDebt
    ///      maxRepaidSettlement = maxRepaidSettlementWithoutInsuranceFundFee / (1 - IFRatio)
    /// @return maxRepaidSettlementX10_S max liquidation value with same decimals as settlementToken
    function _getMaxRepaidSettlement(address trader) internal view returns (uint256 maxRepaidSettlementX10_S) {
        // max(max(-settlementTokenValue, 0), totalMarginReq) * liquidationRatio
        int256 settlementTokenValueX10_S = getSettlementTokenValue(trader);
        uint256 settlementTokenDebtX10_S =
            settlementTokenValueX10_S < 0 ? settlementTokenValueX10_S.neg256().toUint256() : 0;

        uint256 totalMarginRequirementX10_S =
            _getTotalMarginRequirement(trader, IClearingHouseConfig(_clearingHouseConfig).getImRatio());

        uint256 maxDebtX10_S = MathUpgradeable.max(settlementTokenDebtX10_S, totalMarginRequirementX10_S);
        uint256 collateralValueDustX10_S = ICollateralManager(_collateralManager).getCollateralValueDust();
        uint256 maxRepaidSettlementWithoutInsuranceFundFeeX10_S =
            maxDebtX10_S > collateralValueDustX10_S
                ? maxDebtX10_S.mulRatio(ICollateralManager(_collateralManager).getLiquidationRatio())
                : maxDebtX10_S;

        return
            maxRepaidSettlementWithoutInsuranceFundFeeX10_S.divRatio(
                _ONE_HUNDRED_PERCENT_RATIO.subRatio(ICollateralManager(_collateralManager).getCLInsuranceFundFeeRatio())
            );
    }

    /// @return totalMarginRequirementX10_S total margin requirement with decimals of settlementToken
    function _getTotalMarginRequirement(address trader, uint24 ratio)
        internal
        view
        returns (uint256 totalMarginRequirementX10_S)
    {
        uint256 totalDebtValue = IAccountBalance(_accountBalance).getTotalDebtValue(trader);
        return totalDebtValue.mulRatio(ratio).formatSettlementToken(_decimals);
    }

    function _isCollateral(address token) internal view returns (bool) {
        return ICollateralManager(_collateralManager).isCollateral(token);
    }

    function _requireWETH9IsCollateral() internal view {
        // V_WINAC: WETH9 is not a collateral
        require(_isCollateral(_WETH9), "V_WINAC");
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
