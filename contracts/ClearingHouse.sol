// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { ContextUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/MathUpgradeable.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IUniswapV3MintCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { FeeMath } from "./lib/FeeMath.sol";
import { Funding } from "./lib/Funding.sol";
import { PerpFixedPoint96 } from "./lib/PerpFixedPoint96.sol";
import { SettlementTokenMath } from "./lib/SettlementTokenMath.sol";
import { Validation } from "./base/Validation.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { IVault } from "./interface/IVault.sol";
import { BaseRelayRecipient } from "./gsn/BaseRelayRecipient.sol";
import { Exchange } from "./Exchange.sol";
import { AccountMarket } from "./lib/AccountMarket.sol";
import { IOrderBook } from "./interface/IOrderBook.sol";
import { ClearingHouseConfig } from "./ClearingHouseConfig.sol";
import { AccountBalance } from "./AccountBalance.sol";
import { ClearingHouseStorageV1 } from "./storage/ClearingHouseStorage.sol";

contract ClearingHouse is
    IUniswapV3MintCallback,
    IUniswapV3SwapCallback,
    ReentrancyGuardUpgradeable,
    Validation,
    OwnerPausable,
    ClearingHouseStorageV1
{
    using AddressUpgradeable for address;
    using SafeMathUpgradeable for uint256;
    using SafeMathUpgradeable for uint160;
    using PerpSafeCast for uint256;
    using PerpSafeCast for uint128;
    using SignedSafeMathUpgradeable for int256;
    using PerpSafeCast for int256;
    using PerpMath for uint256;
    using PerpMath for int256;
    using PerpMath for uint160;
    using SettlementTokenMath for uint256;
    using SettlementTokenMath for int256;
    using AccountMarket for AccountMarket.Info;

    //
    // STRUCT
    //

    struct AddLiquidityParams {
        address baseToken;
        uint256 base;
        uint256 quote;
        int24 lowerTick;
        int24 upperTick;
        uint256 minBase;
        uint256 minQuote;
        uint256 deadline;
    }

    /// @param liquidity collect fee when 0
    struct RemoveLiquidityParams {
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
        uint256 minBase;
        uint256 minQuote;
        uint256 deadline;
    }

    struct InternalRemoveLiquidityParams {
        address maker;
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
    }

    struct RemoveLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
    }

    struct AddLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
        uint256 liquidity;
    }

    struct OpenPositionParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        // B2Q + exact input, want more output quote as possible, so we set a lower bound of output quote
        // B2Q + exact output, want less input base as possible, so we set a upper bound of input base
        // Q2B + exact input, want more output base as possible, so we set a lower bound of output base
        // Q2B + exact output, want less input quote as possible, so we set a upper bound of input quote
        // when it's 0 in exactInput, means ignore slippage protection
        // when it's maxUint in exactOutput = ignore
        // when it's over or under the bound, it will be reverted
        uint256 oppositeAmountBound;
        uint256 deadline;
        // B2Q: the price cannot be less than this value after the swap
        // Q2B: The price cannot be greater than this value after the swap
        // it will fill the trade until it reach the price limit instead of reverted
        uint160 sqrtPriceLimitX96;
        bytes32 referralCode;
    }

    struct InternalOpenPositionParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        bool isClose;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        bool skipMarginRequirementCheck;
        Funding.Growth fundingGrowthGlobal;
    }

    struct ClosePositionParams {
        address baseToken;
        uint160 sqrtPriceLimitX96;
        uint256 oppositeAmountBound;
        uint256 deadline;
        bytes32 referralCode;
    }

    struct InternalClosePositionParams {
        address trader;
        address baseToken;
        uint160 sqrtPriceLimitX96;
        Funding.Growth fundingGrowthGlobal;
    }

    struct CheckSlippageParams {
        bool isBaseToQuote;
        bool isExactInput;
        uint256 deltaAvailableQuote;
        uint256 deltaAvailableBase;
        uint256 oppositeAmountBound;
    }

    //
    // EVENT
    //

    event PositionLiquidated(
        address indexed trader,
        address indexed baseToken,
        uint256 positionNotional,
        uint256 positionSize,
        uint256 liquidationFee,
        address liquidator
    );
    event ReferredPositionChanged(bytes32 indexed referralCode);

    //
    // MODIFIER
    //

    modifier onlyExchange() {
        // only exchange
        require(_msgSender() == exchange, "CH_OE");
        _;
    }

    //
    // EXTERNAL NON-VIEW
    //

    /// @dev this function is public for testing
    function initialize(
        address clearingHouseConfigArg,
        address vaultArg,
        address quoteTokenArg,
        address uniV3FactoryArg,
        address exchangeArg,
        address accountBalanceArg
    ) public initializer {
        // CH_VANC: Vault address is not contract
        require(vaultArg.isContract(), "CH_VANC");
        // TODO check QuoteToken's balance once this is upgradable
        // CH_QANC: QuoteToken address is not contract
        require(quoteTokenArg.isContract(), "CH_QANC");
        // CH_QDN18: QuoteToken decimals is not 18
        require(IERC20Metadata(quoteTokenArg).decimals() == 18, "CH_QDN18");
        // CH_UANC: UniV3Factory address is not contract
        require(uniV3FactoryArg.isContract(), "CH_UANC");
        // ClearingHouseConfig address is not contract
        require(clearingHouseConfigArg.isContract(), "CH_CCNC");
        // AccountBalance is not contract
        require(accountBalanceArg.isContract(), "CH_ABNC");

        // CH_ANC: address is not contract
        require(exchangeArg.isContract(), "CH_ANC");

        address orderBookArg = Exchange(exchangeArg).orderBook();

        // orderbook is not contarct
        require(orderBookArg.isContract(), "CH_OBNC");

        __ReentrancyGuard_init();
        __OwnerPausable_init();

        clearingHouseConfig = clearingHouseConfigArg;
        vault = vaultArg;
        quoteToken = quoteTokenArg;
        uniswapV3Factory = uniV3FactoryArg;
        exchange = exchangeArg;
        orderBook = orderBookArg;
        accountBalance = accountBalanceArg;

        _settlementTokenDecimals = IVault(vault).decimals();

        // we don't use this var
        versionRecipient = "2.0.0";
    }

    // solhint-disable-next-line func-order
    function setTrustedForwarder(address trustedForwarderArg) external onlyOwner {
        // CH_ANC: address is not contract
        require(trustedForwarderArg.isContract(), "CH_ANC");
        _setTrustedForwarder(trustedForwarderArg);
    }

    function addLiquidity(AddLiquidityParams calldata params)
        external
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (AddLiquidityResponse memory)
    {
        _requireHasBaseToken(params.baseToken);

        address trader = _msgSender();
        // register token if it's the first time
        AccountBalance(accountBalance).registerBaseToken(trader, params.baseToken);

        Funding.Growth memory fundingGrowthGlobal = Exchange(exchange).settleFunding(trader, params.baseToken);

        // note that we no longer check available tokens here because CH will always auto-mint
        // when requested by UniswapV3MintCallback
        IOrderBook.AddLiquidityResponse memory response =
            IOrderBook(orderBook).addLiquidity(
                IOrderBook.AddLiquidityParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    base: params.base,
                    quote: params.quote,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    fundingGrowthGlobal: fundingGrowthGlobal
                })
            );
        // price slippage check
        require(response.base >= params.minBase && response.quote >= params.minQuote, "CH_PSC");

        // collect fee to owedRealizedPnl
        AccountBalance(accountBalance).addBalance(
            trader,
            params.baseToken,
            -(response.base.toInt256()),
            -(response.quote.toInt256()),
            response.fee.toInt256()
        );

        // TODO : WIP
        // must after token info is updated to ensure free collateral is positive after updated
        _requireEnoughFreeCollateral(trader);

        return
            AddLiquidityResponse({
                base: response.base,
                quote: response.quote,
                fee: response.fee,
                liquidity: response.liquidity
            });
    }

    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (RemoveLiquidityResponse memory response)
    {
        _requireHasBaseToken(params.baseToken);
        response = _removeLiquidity(
            InternalRemoveLiquidityParams({
                maker: _msgSender(),
                baseToken: params.baseToken,
                lowerTick: params.lowerTick,
                upperTick: params.upperTick,
                liquidity: params.liquidity
            })
        );

        // price slippage check
        require(response.base >= params.minBase && response.quote >= params.minQuote, "CH_PSC");
    }

    function openPosition(OpenPositionParams memory params)
        external
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 deltaBase, uint256 deltaQuote)
    {
        address trader = _msgSender();

        _requireHasBaseToken(params.baseToken);
        AccountBalance(accountBalance).registerBaseToken(trader, params.baseToken);

        // must before price impact check
        Funding.Growth memory fundingGrowthGlobal = Exchange(exchange).settleFunding(trader, params.baseToken);

        Exchange.SwapResponse memory response =
            _openPosition(
                InternalOpenPositionParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    isClose: false,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    skipMarginRequirementCheck: false,
                    fundingGrowthGlobal: fundingGrowthGlobal
                })
            );

        _checkSlippage(
            CheckSlippageParams({
                isBaseToQuote: params.isBaseToQuote,
                isExactInput: params.isExactInput,
                deltaAvailableQuote: response.deltaAvailableQuote,
                deltaAvailableBase: response.deltaAvailableBase,
                oppositeAmountBound: params.oppositeAmountBound
            })
        );

        emit ReferredPositionChanged(params.referralCode);
        return (response.deltaAvailableBase, response.deltaAvailableQuote);
    }

    function closePosition(ClosePositionParams calldata params)
        external
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 deltaBase, uint256 deltaQuote)
    {
        _requireHasBaseToken(params.baseToken);

        address trader = _msgSender();
        Funding.Growth memory fundingGrowthGlobal = Exchange(exchange).settleFunding(trader, params.baseToken);

        Exchange.SwapResponse memory response =
            _closePosition(
                InternalClosePositionParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    fundingGrowthGlobal: fundingGrowthGlobal
                })
            );

        // if exchangedPositionSize < 0, closing it is short, B2Q; else, closing it is long, Q2B
        bool isBaseToQuote = response.exchangedPositionSize < 0 ? true : false;
        _checkSlippage(
            CheckSlippageParams({
                isBaseToQuote: isBaseToQuote,
                isExactInput: isBaseToQuote,
                deltaAvailableQuote: response.deltaAvailableQuote,
                deltaAvailableBase: response.deltaAvailableBase,
                oppositeAmountBound: params.oppositeAmountBound
            })
        );

        emit ReferredPositionChanged(params.referralCode);
        return (response.deltaAvailableBase, response.deltaAvailableQuote);
    }

    function liquidate(address trader, address baseToken) external whenNotPaused nonReentrant {
        _requireHasBaseToken(baseToken);
        // per liquidation specs:
        //   https://www.notion.so/perp/Perpetual-Swap-Contract-s-Specs-Simulations-96e6255bf77e4c90914855603ff7ddd1
        //
        // liquidation trigger:
        //   accountMarginRatio < accountMaintenanceMarginRatio
        //   => accountValue / sum(abs(positionValue_market)) <
        //        sum(mmRatio * abs(positionValue_market)) / sum(abs(positionValue_market))
        //   => accountValue < sum(mmRatio * abs(positionValue_market))
        //   => accountValue < sum(abs(positionValue_market)) * mmRatio = totalMinimumMarginRequirement
        //

        // CH_EAV: enough account value
        require(
            getAccountValue(trader).lt(
                AccountBalance(accountBalance).getLiquidateMarginRequirement(trader),
                _settlementTokenDecimals
            ),
            "CH_EAV"
        );

        // CH_NEO: not empty order
        require(!AccountBalance(accountBalance).hasOrder(trader), "CH_NEO");

        Funding.Growth memory fundingGrowthGlobal = Exchange(exchange).settleFunding(trader, baseToken);
        Exchange.SwapResponse memory response =
            _closePosition(
                InternalClosePositionParams({
                    trader: trader,
                    baseToken: baseToken,
                    sqrtPriceLimitX96: 0,
                    fundingGrowthGlobal: fundingGrowthGlobal
                })
            );

        // trader's pnl-- as liquidation penalty
        uint256 liquidationFee =
            response.exchangedPositionNotional.abs().mulRatio(
                ClearingHouseConfig(clearingHouseConfig).liquidationPenaltyRatio()
            );

        AccountBalance(accountBalance).addOwedRealizedPnl(trader, -liquidationFee.toInt256());

        // increase liquidator's pnl liquidation reward
        address liquidator = _msgSender();
        AccountBalance(accountBalance).addOwedRealizedPnl(liquidator, liquidationFee.toInt256());

        emit PositionLiquidated(
            trader,
            baseToken,
            response.exchangedPositionNotional.abs(),
            response.deltaAvailableBase,
            liquidationFee,
            liquidator
        );
    }

    function cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] calldata orderIds
    ) external whenNotPaused nonReentrant {
        _cancelExcessOrders(maker, baseToken, orderIds);
    }

    function cancelAllExcessOrders(address maker, address baseToken) external whenNotPaused nonReentrant {
        bytes32[] memory orderIds = IOrderBook(orderBook).getOpenOrderIds(maker, baseToken);
        _cancelExcessOrders(maker, baseToken, orderIds);
    }

    /// @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        // not orderBook
        require(_msgSender() == orderBook, "CH_NOB");

        IOrderBook.MintCallbackData memory callbackData = abi.decode(data, (IOrderBook.MintCallbackData));

        if (amount0Owed > 0) {
            address token = IUniswapV3Pool(callbackData.pool).token0();
            IERC20Metadata(token).transfer(callbackData.pool, amount0Owed);
        }
        if (amount1Owed > 0) {
            address token = IUniswapV3Pool(callbackData.pool).token1();
            IERC20Metadata(token).transfer(callbackData.pool, amount1Owed);
        }
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override onlyExchange {
        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // CH_F0S: forbidden 0 swap
        require(amount0Delta > 0 || amount1Delta > 0, "CH_F0S");

        Exchange.SwapCallbackData memory callbackData = abi.decode(data, (Exchange.SwapCallbackData));
        IUniswapV3Pool uniswapV3Pool = IUniswapV3Pool(callbackData.pool);

        // amount0Delta & amount1Delta are guaranteed to be positive when being the amount to be paid
        (address token, uint256 amountToPay) =
            amount0Delta > 0
                ? (uniswapV3Pool.token0(), uint256(amount0Delta))
                : (uniswapV3Pool.token1(), uint256(amount1Delta));

        // swap
        IERC20Metadata(token).transfer(address(callbackData.pool), amountToPay);
    }

    //
    // EXTERNAL VIEW
    //

    /// @dev accountValue = totalCollateralValue + totalUnrealizedPnl, in the settlement token's decimals
    function getAccountValue(address trader) public view returns (int256) {
        int256 fundingPayment = Exchange(exchange).getAllPendingFundingPayment(trader);
        (int256 owedRealizedPnl, int256 unrealizedPnl) = AccountBalance(accountBalance).getOwedAndUnrealizedPnl(trader);
        int256 totalCollateral =
            IVault(vault).balanceOf(trader).addS(owedRealizedPnl.sub(fundingPayment), _settlementTokenDecimals);

        return totalCollateral.addS(unrealizedPnl, _settlementTokenDecimals);
    }

    //
    // INTERNAL NON-VIEW
    //

    function _cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] memory orderIds
    ) internal {
        _requireHasBaseToken(baseToken);

        // CH_NEXO: not excess orders
        // only cancel open orders if there are not enough free collateral with mmRatio or account is liquidable.
        require(
            (_getFreeCollateralByRatio(maker, ClearingHouseConfig(clearingHouseConfig).mmRatio()) < 0) ||
                getAccountValue(maker).lt(
                    AccountBalance(accountBalance).getLiquidateMarginRequirement(maker),
                    _settlementTokenDecimals
                ),
            "CH_NEXO"
        );

        // must settle funding before getting token info
        Exchange(exchange).settleFunding(maker, baseToken);
        IOrderBook.RemoveLiquidityResponse memory response =
            IOrderBook(orderBook).removeLiquidityByIds(maker, baseToken, orderIds);

        AccountBalance(accountBalance).addBalance(
            maker,
            baseToken,
            response.base.toInt256(),
            response.quote.toInt256(),
            response.fee.toInt256()
        );
        AccountBalance(accountBalance).deregisterBaseToken(maker, baseToken);
    }

    function _removeLiquidity(InternalRemoveLiquidityParams memory params)
        internal
        returns (RemoveLiquidityResponse memory)
    {
        // must settle funding before getting token info
        Exchange(exchange).settleFunding(params.maker, params.baseToken);
        IOrderBook.RemoveLiquidityResponse memory response =
            IOrderBook(orderBook).removeLiquidity(
                IOrderBook.RemoveLiquidityParams({
                    maker: params.maker,
                    baseToken: params.baseToken,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    liquidity: params.liquidity
                })
            );

        AccountBalance(accountBalance).addBalance(
            params.maker,
            params.baseToken,
            response.base.toInt256(),
            response.quote.toInt256(),
            response.fee.toInt256()
        );
        AccountBalance(accountBalance).deregisterBaseToken(params.maker, params.baseToken);

        return RemoveLiquidityResponse({ quote: response.quote, base: response.base, fee: response.fee });
    }

    /// @dev explainer diagram for the relationship between exchangedPositionNotional, fee and openNotional:
    ///      https://www.figma.com/file/xuue5qGH4RalX7uAbbzgP3/swap-accounting-and-events
    function _openPosition(InternalOpenPositionParams memory params) internal returns (Exchange.SwapResponse memory) {
        Exchange.SwapResponse memory response =
            Exchange(exchange).swap(
                Exchange.SwapParams({
                    trader: params.trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    isClose: params.isClose,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    fundingGrowthGlobal: params.fundingGrowthGlobal
                })
            );

        if (!params.skipMarginRequirementCheck) {
            // it's not closing the position, check margin ratio
            _requireEnoughFreeCollateral(params.trader);
        }

        AccountBalance(accountBalance).deregisterBaseToken(params.trader, params.baseToken);

        return response;
    }

    function _closePosition(InternalClosePositionParams memory params) internal returns (Exchange.SwapResponse memory) {
        int256 positionSize = AccountBalance(accountBalance).getPositionSize(params.trader, params.baseToken);

        // CH_PSZ: position size is zero
        require(positionSize != 0, "CH_PSZ");

        bool isLong = positionSize > 0 ? true : false;
        return
            _openPosition(
                InternalOpenPositionParams({
                    trader: params.trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: isLong,
                    isExactInput: isLong,
                    isClose: true,
                    amount: positionSize.abs(),
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    skipMarginRequirementCheck: true,
                    fundingGrowthGlobal: params.fundingGrowthGlobal
                })
            );
    }

    //
    // INTERNAL VIEW
    //

    /// @inheritdoc BaseRelayRecipient
    function _msgSender() internal view override(BaseRelayRecipient, OwnerPausable) returns (address payable) {
        return super._msgSender();
    }

    /// @inheritdoc BaseRelayRecipient
    function _msgData() internal view override(BaseRelayRecipient, OwnerPausable) returns (bytes memory) {
        return super._msgData();
    }

    // TODO remove, should check in exchange
    function _requireHasBaseToken(address baseToken) internal view {
        // CH_BTNE: base token not exists
        require(Exchange(exchange).getPool(baseToken) != address(0), "CH_BTNE");
    }

    function _getFreeCollateralByRatio(address trader, uint24 ratio) internal view returns (int256) {
        return IVault(vault).getFreeCollateralByRatio(trader, ratio);
    }

    function _requireEnoughFreeCollateral(address trader) internal view {
        // CH_NEFCI: not enough account value by imRatio
        // freeCollateral is calculated with imRatio
        require(_getFreeCollateralByRatio(trader, ClearingHouseConfig(clearingHouseConfig).imRatio()) >= 0, "CH_NEFCI");
    }

    function _checkSlippage(CheckSlippageParams memory params) internal pure {
        // skip when params.oppositeAmountBound is zero
        if (params.oppositeAmountBound == 0) {
            return;
        }

        // B2Q + exact input, want more output quote as possible, so we set a lower bound of output quote
        // B2Q + exact output, want less input base as possible, so we set a upper bound of input base
        // Q2B + exact input, want more output base as possible, so we set a lower bound of output base
        // Q2B + exact output, want less input quote as possible, so we set a upper bound of input quote
        if (params.isBaseToQuote) {
            if (params.isExactInput) {
                // too little received when short
                require(params.deltaAvailableQuote >= params.oppositeAmountBound, "CH_TLRS");
            } else {
                // too much requested when short
                require(params.deltaAvailableBase <= params.oppositeAmountBound, "CH_TMRS");
            }
        } else {
            if (params.isExactInput) {
                // too little received when long
                require(params.deltaAvailableBase >= params.oppositeAmountBound, "CH_TLRL");
            } else {
                // too much requested when long
                require(params.deltaAvailableQuote <= params.oppositeAmountBound, "CH_TMRL");
            }
        }
    }
}
