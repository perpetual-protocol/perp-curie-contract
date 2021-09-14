// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { SwapMath } from "@uniswap/v3-core/contracts/libraries/SwapMath.sol";
import { LiquidityMath } from "@uniswap/v3-core/contracts/libraries/LiquidityMath.sol";
import { FixedPoint128 } from "@uniswap/v3-core/contracts/libraries/FixedPoint128.sol";
import { IUniswapV3MintCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import { LiquidityAmounts } from "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";
import { UniswapV3Broker, IUniswapV3Pool } from "./lib/UniswapV3Broker.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { FeeMath } from "./lib/FeeMath.sol";
import { PerpFixedPoint96 } from "./lib/PerpFixedPoint96.sol";
import { Funding } from "./lib/Funding.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { OrderKey } from "./lib/OrderKey.sol";
import { Tick } from "./lib/Tick.sol";
import { ClearingHouseDelegate } from "./base/ClearingHouseDelegate.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { VirtualToken } from "./VirtualToken.sol";
import { MarketRegistry } from "./MarketRegistry.sol";

contract OrderBook is IUniswapV3MintCallback, ClearingHouseDelegate {
    using SafeMathUpgradeable for uint256;
    using SafeMathUpgradeable for uint128;
    using SignedSafeMathUpgradeable for int256;
    using PerpMath for uint256;
    using PerpMath for int256;
    using PerpMath for uint160;
    using PerpSafeCast for uint256;
    using PerpSafeCast for uint128;
    using PerpSafeCast for int256;
    using Tick for mapping(int24 => Tick.GrowthInfo);

    //
    // STRUCT
    //
    struct AddLiquidityParams {
        address trader;
        address baseToken;
        uint256 base;
        uint256 quote;
        int24 lowerTick;
        int24 upperTick;
        Funding.Growth fundingGrowthGlobal;
    }

    struct AddLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
        uint128 liquidity;
    }

    struct RemoveLiquidityParams {
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

    struct InternalAddLiquidityToOrderParams {
        address maker;
        address baseToken;
        address pool;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthGlobalX128;
        uint128 liquidity;
        Funding.Growth globalFundingGrowth;
    }

    /// @param lastFeeGrowthInsideX128 fees in quote token recorded in Exchange
    ///        because of block-based funding, quote-only and customized fee, all fees are in quote token
    struct OpenOrder {
        uint128 liquidity;
        int24 lowerTick;
        int24 upperTick;
        uint256 lastFeeGrowthInsideX128;
        int256 lastTwPremiumGrowthInsideX96;
        int256 lastTwPremiumGrowthBelowX96;
        int256 lastTwPremiumDivBySqrtPriceGrowthInsideX96;
    }

    struct MintCallbackData {
        address trader;
        address pool;
    }

    struct InternalRemoveLiquidityFromOrderParams {
        address maker;
        address baseToken;
        address pool;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
    }

    struct SwapStep {
        uint160 initialSqrtPriceX96;
        int24 nextTick;
        bool isNextTickInitialized;
        uint160 nextSqrtPriceX96;
        uint256 amountIn;
        uint256 amountOut;
        uint256 feeAmount;
    }

    struct ReplaySwapParams {
        address baseToken;
        bool isBaseToQuote;
        bool shouldUpdateState;
        int256 amount;
        uint160 sqrtPriceLimitX96;
        uint24 exchangeFeeRatio;
        uint24 uniswapFeeRatio;
        Funding.Growth globalFundingGrowth;
    }

    struct ReplaySwapResponse {
        int24 tick;
        uint256 fee; // exchangeFeeRatio
        uint256 insuranceFundFee; // insuranceFundFee = exchangeFeeRatio * insuranceFundFeeRatio
    }

    //
    // EVENT
    //
    event LiquidityChanged(
        address indexed maker,
        address indexed baseToken,
        address indexed quoteToken,
        int24 lowerTick,
        int24 upperTick,
        // amount of base token added to the liquidity (excl. fee) (+: add liquidity, -: remove liquidity)
        int256 base,
        // amount of quote token added to the liquidity (excl. fee) (+: add liquidity, -: remove liquidity)
        int256 quote,
        int128 liquidity, // amount of liquidity unit added (+: add liquidity, -: remove liquidity)
        uint256 quoteFee // amount of quote token the maker received as fee
    );

    //
    // STATE
    //
    address public quoteToken;
    address public exchange;

    // first key: trader, second key: base token
    mapping(address => mapping(address => bytes32[])) internal _openOrderIdsMap;

    // key: openOrderId
    mapping(bytes32 => OpenOrder) internal _openOrderMap;

    // first key: base token, second key: tick index
    // value: the accumulator of **Tick.GrowthInfo** outside each tick of each pool
    mapping(address => mapping(int24 => Tick.GrowthInfo)) internal _growthOutsideTickMap;

    // key: base token
    // value: the global accumulator of **quote fee transformed from base fee** of each pool
    mapping(address => uint256) internal _feeGrowthGlobalX128Map;

    //
    // CONSTRUCTOR
    //
    function initialize(address marketRegistryArg, address quoteTokenArg) external initializer {
        __ClearingHouseDelegator_init(marketRegistryArg);

        // QuoteToken is 0
        require(quoteTokenArg != address(0), "OB_QT0");

        // update states
        quoteToken = quoteTokenArg;
    }

    //
    // EXTERNAL ADMIN FUNCTIONS
    //
    function setExchange(address exchangeArg) external onlyOwner {
        // Exchange is 0
        require(exchangeArg != address(0), "OB_CH0");
        exchange = exchangeArg;
    }

    //
    // EXTERNAL FUNCTIONS
    //

    function addLiquidity(AddLiquidityParams calldata params)
        external
        onlyClearingHouse
        returns (AddLiquidityResponse memory)
    {
        address pool = MarketRegistry(marketRegistry).getPool(params.baseToken);
        uint256 feeGrowthGlobalX128 = _feeGrowthGlobalX128Map[params.baseToken];
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[params.baseToken];
        UniswapV3Broker.AddLiquidityResponse memory response;

        {
            bool initializedBeforeLower = UniswapV3Broker.getIsTickInitialized(pool, params.lowerTick);
            bool initializedBeforeUpper = UniswapV3Broker.getIsTickInitialized(pool, params.upperTick);

            // add liquidity to liquidity pool
            response = UniswapV3Broker.addLiquidity(
                UniswapV3Broker.AddLiquidityParams(
                    pool,
                    params.lowerTick,
                    params.upperTick,
                    params.base,
                    params.quote,
                    abi.encode(MintCallbackData(params.trader, pool))
                )
            );
            // mint callback

            int24 currentTick = UniswapV3Broker.getTick(pool);
            // initialize tick info
            if (!initializedBeforeLower && UniswapV3Broker.getIsTickInitialized(pool, params.lowerTick)) {
                tickMap.initialize(
                    params.lowerTick,
                    currentTick,
                    Tick.GrowthInfo(
                        feeGrowthGlobalX128,
                        params.fundingGrowthGlobal.twPremiumX96,
                        params.fundingGrowthGlobal.twPremiumDivBySqrtPriceX96
                    )
                );
            }
            if (!initializedBeforeUpper && UniswapV3Broker.getIsTickInitialized(pool, params.upperTick)) {
                tickMap.initialize(
                    params.upperTick,
                    currentTick,
                    Tick.GrowthInfo(
                        feeGrowthGlobalX128,
                        params.fundingGrowthGlobal.twPremiumX96,
                        params.fundingGrowthGlobal.twPremiumDivBySqrtPriceX96
                    )
                );
            }
        }

        // mutate states
        uint256 fee =
            _addLiquidityToOrder(
                InternalAddLiquidityToOrderParams({
                    maker: params.trader,
                    baseToken: params.baseToken,
                    pool: pool,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    feeGrowthGlobalX128: feeGrowthGlobalX128,
                    liquidity: response.liquidity,
                    globalFundingGrowth: params.fundingGrowthGlobal
                })
            );

        emit LiquidityChanged(
            params.trader,
            params.baseToken,
            quoteToken,
            params.lowerTick,
            params.upperTick,
            response.base.toInt256(),
            response.quote.toInt256(),
            response.liquidity.toInt128(),
            fee
        );

        return
            AddLiquidityResponse({
                base: response.base,
                quote: response.quote,
                fee: fee,
                liquidity: response.liquidity
            });
    }

    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        onlyClearingHouse
        returns (RemoveLiquidityResponse memory)
    {
        return _removeLiquidity(params);
    }

    function removeLiquidityByIds(
        address maker,
        address baseToken,
        bytes32[] calldata orderIds
    ) external onlyClearingHouse returns (RemoveLiquidityResponse memory) {
        uint256 totalBase;
        uint256 totalQuote;
        uint256 totalFee;
        for (uint256 i = 0; i < orderIds.length; i++) {
            bytes32 orderId = orderIds[i];
            OpenOrder memory order = _openOrderMap[orderId];

            RemoveLiquidityResponse memory response =
                _removeLiquidity(
                    RemoveLiquidityParams({
                        maker: maker,
                        baseToken: baseToken,
                        lowerTick: order.lowerTick,
                        upperTick: order.upperTick,
                        liquidity: order.liquidity
                    })
                );

            totalBase = totalBase.add(response.base);
            totalQuote = totalQuote.add(response.quote);
            totalFee = totalFee.add(response.fee);
        }

        return RemoveLiquidityResponse({ base: totalBase, quote: totalQuote, fee: totalFee });
    }

    /// @dev this is the non-view version of getLiquidityCoefficientInFundingPayment()
    /// @return liquidityCoefficientInFundingPayment the funding payment of all orders/liquidity of a maker
    function updateFundingGrowthAndLiquidityCoefficientInFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory fundingGrowthGlobal
    ) external onlyClearingHouse returns (int256 liquidityCoefficientInFundingPayment) {
        bytes32[] memory orderIds = _openOrderIdsMap[trader][baseToken];
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[baseToken];
        address pool = MarketRegistry(marketRegistry).getPool(baseToken);

        // funding of liquidity coefficient
        for (uint256 i = 0; i < orderIds.length; i++) {
            OpenOrder storage order = _openOrderMap[orderIds[i]];
            Tick.FundingGrowthRangeInfo memory fundingGrowthRangeInfo =
                tickMap.getAllFundingGrowth(
                    order.lowerTick,
                    order.upperTick,
                    UniswapV3Broker.getTick(pool),
                    fundingGrowthGlobal.twPremiumX96,
                    fundingGrowthGlobal.twPremiumDivBySqrtPriceX96
                );

            // the calculation here is based on cached values
            liquidityCoefficientInFundingPayment = liquidityCoefficientInFundingPayment.add(
                _getLiquidityCoefficientInFundingPaymentByOrder(order, fundingGrowthRangeInfo)
            );

            // thus, state updates have to come after
            order.lastTwPremiumGrowthInsideX96 = fundingGrowthRangeInfo.twPremiumGrowthInsideX96;
            order.lastTwPremiumGrowthBelowX96 = fundingGrowthRangeInfo.twPremiumGrowthBelowX96;
            order.lastTwPremiumDivBySqrtPriceGrowthInsideX96 = fundingGrowthRangeInfo
                .twPremiumDivBySqrtPriceGrowthInsideX96;
        }

        return liquidityCoefficientInFundingPayment;
    }

    /// @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override checkCallback {
        IUniswapV3MintCallback(clearingHouse).uniswapV3MintCallback(amount0Owed, amount1Owed, data);
    }

    function replaySwap(ReplaySwapParams memory params) external returns (ReplaySwapResponse memory) {
        require(_msgSender() == exchange, "OB_OEX");
        address pool = MarketRegistry(marketRegistry).getPool(params.baseToken);
        bool isExactInput = params.amount > 0;
        uint24 insuranceFundFeeRatio =
            MarketRegistry(marketRegistry).getMarketInfo(params.baseToken).insuranceFundFeeRatio;
        uint256 feeResult; // exchangeFeeRatio
        uint256 insuranceFundFeeResult; // insuranceFundFee = exchangeFeeRatio * insuranceFundFeeRatio

        UniswapV3Broker.SwapState memory swapState =
            UniswapV3Broker.getSwapState(pool, params.amount, _feeGrowthGlobalX128Map[params.baseToken]);

        params.sqrtPriceLimitX96 = params.sqrtPriceLimitX96 == 0
            ? (params.isBaseToQuote ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
            : params.sqrtPriceLimitX96;

        // if there is residue in amountSpecifiedRemaining, makers can get a tiny little bit less than expected,
        // which is safer for the system
        while (swapState.amountSpecifiedRemaining != 0 && swapState.sqrtPriceX96 != params.sqrtPriceLimitX96) {
            SwapStep memory step;
            step.initialSqrtPriceX96 = swapState.sqrtPriceX96;

            // find next tick
            // note the search is bounded in one word
            (step.nextTick, step.isNextTickInitialized) = UniswapV3Broker.getNextInitializedTickWithinOneWord(
                pool,
                swapState.tick,
                UniswapV3Broker.getTickSpacing(pool),
                params.isBaseToQuote
            );

            // ensure that we do not overshoot the min/max tick, as the tick bitmap is not aware of these bounds
            if (step.nextTick < TickMath.MIN_TICK) {
                step.nextTick = TickMath.MIN_TICK;
            } else if (step.nextTick > TickMath.MAX_TICK) {
                step.nextTick = TickMath.MAX_TICK;
            }

            // get the next price of this step (either next tick's price or the ending price)
            // use sqrtPrice instead of tick is more precise
            step.nextSqrtPriceX96 = TickMath.getSqrtRatioAtTick(step.nextTick);

            // find the next swap checkpoint
            // (either reached the next price of this step, or exhausted remaining amount specified)
            (swapState.sqrtPriceX96, step.amountIn, step.amountOut, step.feeAmount) = SwapMath.computeSwapStep(
                swapState.sqrtPriceX96,
                (
                    params.isBaseToQuote
                        ? step.nextSqrtPriceX96 < params.sqrtPriceLimitX96
                        : step.nextSqrtPriceX96 > params.sqrtPriceLimitX96
                )
                    ? params.sqrtPriceLimitX96
                    : step.nextSqrtPriceX96,
                swapState.liquidity,
                swapState.amountSpecifiedRemaining,
                // isBaseToQuote: fee is charged in base token in uniswap pool; thus, use uniswapFeeRatio to replay
                // !isBaseToQuote: fee is charged in quote token in clearing house; thus, use exchangeFeeRatioRatio
                params.isBaseToQuote ? params.uniswapFeeRatio : params.exchangeFeeRatio
            );

            // user input 1 quote:
            // quote token to uniswap ===> 1*0.98/0.99 = 0.98989899
            // fee = 0.98989899 * 2% = 0.01979798
            if (isExactInput) {
                swapState.amountSpecifiedRemaining -= (step.amountIn + step.feeAmount).toInt256();
            } else {
                swapState.amountSpecifiedRemaining += step.amountOut.toInt256();
            }

            // update CH's global fee growth if there is liquidity in this range
            // note CH only collects quote fee when swapping base -> quote
            if (swapState.liquidity > 0) {
                if (params.isBaseToQuote) {
                    step.feeAmount = FullMath.mulDivRoundingUp(step.amountOut, params.exchangeFeeRatio, 1e6);
                }

                feeResult += step.feeAmount;
                uint256 stepInsuranceFundFee = FullMath.mulDivRoundingUp(step.feeAmount, insuranceFundFeeRatio, 1e6);
                insuranceFundFeeResult += stepInsuranceFundFee;
                uint256 stepMakerFee = step.feeAmount.sub(stepInsuranceFundFee);
                swapState.feeGrowthGlobalX128 += FullMath.mulDiv(stepMakerFee, FixedPoint128.Q128, swapState.liquidity);
            }

            if (swapState.sqrtPriceX96 == step.nextSqrtPriceX96) {
                // we have reached the tick's boundary
                if (step.isNextTickInitialized) {
                    if (params.shouldUpdateState) {
                        // update the tick if it has been initialized
                        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[params.baseToken];
                        // according to the above updating logic,
                        // if isBaseToQuote, state.feeGrowthGlobalX128 will be updated; else, will never be updated
                        tickMap.cross(
                            step.nextTick,
                            Tick.GrowthInfo({
                                feeX128: swapState.feeGrowthGlobalX128,
                                twPremiumX96: params.globalFundingGrowth.twPremiumX96,
                                twPremiumDivBySqrtPriceX96: params.globalFundingGrowth.twPremiumDivBySqrtPriceX96
                            })
                        );
                    }

                    int128 liquidityNet = UniswapV3Broker.getTickLiquidityNet(pool, step.nextTick);
                    if (params.isBaseToQuote) liquidityNet = -liquidityNet;
                    swapState.liquidity = LiquidityMath.addDelta(swapState.liquidity, liquidityNet);
                }

                swapState.tick = params.isBaseToQuote ? step.nextTick - 1 : step.nextTick;
            } else if (swapState.sqrtPriceX96 != step.initialSqrtPriceX96) {
                // update state.tick corresponding to the current price if the price has changed in this step
                swapState.tick = TickMath.getTickAtSqrtRatio(swapState.sqrtPriceX96);
            }
        }
        if (params.shouldUpdateState) {
            // update global states since swap state transitions are all done
            _feeGrowthGlobalX128Map[params.baseToken] = swapState.feeGrowthGlobalX128;
        }

        return ReplaySwapResponse({ tick: swapState.tick, fee: feeResult, insuranceFundFee: insuranceFundFeeResult });
    }

    //
    // EXTERNAL VIEW
    //

    function getOpenOrderIds(address trader, address baseToken) external view returns (bytes32[] memory) {
        return _openOrderIdsMap[trader][baseToken];
    }

    function getOpenOrder(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view returns (OpenOrder memory) {
        return _openOrderMap[OrderKey.compute(trader, baseToken, lowerTick, upperTick)];
    }

    function hasOrder(address trader, address[] calldata tokens) external view returns (bool) {
        for (uint256 i = 0; i < tokens.length; i++) {
            if (_openOrderIdsMap[trader][tokens[i]].length > 0) {
                return true;
            }
        }
        return false;
    }

    /// @dev note the return value includes maker fee.
    ///      For more details please refer to _getTotalTokenAmountInPool() docstring
    function getTotalQuoteAmountInPools(address trader, address[] calldata baseTokens) external view returns (uint256) {
        uint256 totalQuoteAmountInPools;
        for (uint256 i = 0; i < baseTokens.length; i++) {
            address baseToken = baseTokens[i];
            uint256 quoteInPool = _getTotalTokenAmountInPool(trader, baseToken, false);
            totalQuoteAmountInPools = totalQuoteAmountInPools.add(quoteInPool);
        }
        return totalQuoteAmountInPools;
    }

    /// @dev the returned quote amount does not include funding payment because
    ///      the latter is counted directly toward realizedPnl.
    ///      please refer to _getTotalTokenAmountInPool() docstring for specs
    function getTotalTokenAmountInPool(
        address trader,
        address baseToken,
        bool fetchBase // true: fetch base amount, false: fetch quote amount
    ) external view returns (uint256 tokenAmount) {
        return _getTotalTokenAmountInPool(trader, baseToken, fetchBase);
    }

    /// @dev this is the view version of updateFundingGrowthAndLiquidityCoefficientInFundingPayment()
    /// @return liquidityCoefficientInFundingPayment the funding payment of all orders/liquidity of a maker
    function getLiquidityCoefficientInFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory fundingGrowthGlobal
    ) external view returns (int256 liquidityCoefficientInFundingPayment) {
        bytes32[] memory orderIds = _openOrderIdsMap[trader][baseToken];
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[baseToken];
        address pool = MarketRegistry(marketRegistry).getPool(baseToken);

        // funding of liquidity coefficient
        for (uint256 i = 0; i < orderIds.length; i++) {
            OpenOrder memory order = _openOrderMap[orderIds[i]];
            Tick.FundingGrowthRangeInfo memory fundingGrowthRangeInfo =
                tickMap.getAllFundingGrowth(
                    order.lowerTick,
                    order.upperTick,
                    UniswapV3Broker.getTick(pool),
                    fundingGrowthGlobal.twPremiumX96,
                    fundingGrowthGlobal.twPremiumDivBySqrtPriceX96
                );

            // the calculation here is based on cached values
            liquidityCoefficientInFundingPayment = liquidityCoefficientInFundingPayment.add(
                _getLiquidityCoefficientInFundingPaymentByOrder(order, fundingGrowthRangeInfo)
            );
        }

        return liquidityCoefficientInFundingPayment;
    }

    function getFeeGrowthGlobal(address baseToken) external view returns (uint256) {
        return _feeGrowthGlobalX128Map[baseToken];
    }

    //
    // INTERNAL
    //
    function _removeLiquidity(RemoveLiquidityParams memory params) internal returns (RemoveLiquidityResponse memory) {
        // load existing open order
        bytes32 orderId = OrderKey.compute(params.maker, params.baseToken, params.lowerTick, params.upperTick);
        OpenOrder storage openOrder = _openOrderMap[orderId];
        // non-existent openOrder
        require(openOrder.liquidity > 0, "OB_NEO");
        // not enough liquidity
        require(params.liquidity <= openOrder.liquidity, "OB_NEL");

        address pool = MarketRegistry(marketRegistry).getPool(params.baseToken);
        UniswapV3Broker.RemoveLiquidityResponse memory response =
            UniswapV3Broker.removeLiquidity(
                UniswapV3Broker.RemoveLiquidityParams(
                    pool,
                    exchange,
                    params.lowerTick,
                    params.upperTick,
                    params.liquidity
                )
            );

        // update token info based on existing open order
        uint256 fee =
            _removeLiquidityFromOrder(
                InternalRemoveLiquidityFromOrderParams({
                    maker: params.maker,
                    baseToken: params.baseToken,
                    pool: pool,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    liquidity: params.liquidity
                })
            );

        // if flipped from initialized to uninitialized, clear the tick info
        if (!UniswapV3Broker.getIsTickInitialized(pool, params.lowerTick)) {
            _growthOutsideTickMap[params.baseToken].clear(params.lowerTick);
        }
        if (!UniswapV3Broker.getIsTickInitialized(pool, params.upperTick)) {
            _growthOutsideTickMap[params.baseToken].clear(params.upperTick);
        }

        emit LiquidityChanged(
            params.maker,
            params.baseToken,
            quoteToken,
            params.lowerTick,
            params.upperTick,
            -response.base.toInt256(),
            -response.quote.toInt256(),
            -params.liquidity.toInt128(),
            fee
        );

        return RemoveLiquidityResponse({ base: response.base, quote: response.quote, fee: fee });
    }

    function _removeLiquidityFromOrder(InternalRemoveLiquidityFromOrderParams memory params)
        internal
        returns (uint256)
    {
        // update token info based on existing open order
        bytes32 orderId = OrderKey.compute(params.maker, params.baseToken, params.lowerTick, params.upperTick);
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[params.baseToken];
        OpenOrder storage openOrder = _openOrderMap[orderId];
        uint256 feeGrowthInsideX128 =
            tickMap.getFeeGrowthInsideX128(
                params.lowerTick,
                params.upperTick,
                UniswapV3Broker.getTick(params.pool),
                _feeGrowthGlobalX128Map[params.baseToken]
            );
        uint256 fee = _calcOwedFee(openOrder.liquidity, feeGrowthInsideX128, openOrder.lastFeeGrowthInsideX128);

        // update open order with new liquidity
        openOrder.liquidity = openOrder.liquidity.sub(params.liquidity).toUint128();
        if (openOrder.liquidity == 0) {
            _removeOrder(params.maker, params.baseToken, orderId);
        } else {
            openOrder.lastFeeGrowthInsideX128 = feeGrowthInsideX128;
        }

        return fee;
    }

    function _removeOrder(
        address maker,
        address baseToken,
        bytes32 orderId
    ) internal {
        bytes32[] storage orderIds = _openOrderIdsMap[maker][baseToken];
        uint256 idx;
        for (idx = 0; idx < orderIds.length; idx++) {
            if (orderIds[idx] == orderId) {
                // found the existing order ID
                // remove it from the array efficiently by re-ordering and deleting the last element
                orderIds[idx] = orderIds[orderIds.length - 1];
                orderIds.pop();
                break;
            }
        }
        delete _openOrderMap[orderId];
    }

    function _addLiquidityToOrder(InternalAddLiquidityToOrderParams memory params) internal returns (uint256) {
        // load existing open order
        bytes32 orderId = OrderKey.compute(params.maker, params.baseToken, params.lowerTick, params.upperTick);
        OpenOrder storage openOrder = _openOrderMap[orderId];

        uint256 feeGrowthInsideX128;
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[params.baseToken];
        uint256 fee;
        if (openOrder.liquidity == 0) {
            // it's a new order
            bytes32[] storage orderIds = _openOrderIdsMap[params.maker][params.baseToken];
            // OB_ONE: orders number exceeded
            uint8 maxOrdersPerMarket = MarketRegistry(marketRegistry).maxOrdersPerMarket();
            require(maxOrdersPerMarket == 0 || orderIds.length < maxOrdersPerMarket, "OB_ONE");
            orderIds.push(orderId);

            openOrder.lowerTick = params.lowerTick;
            openOrder.upperTick = params.upperTick;

            Tick.FundingGrowthRangeInfo memory fundingGrowthRangeInfo =
                tickMap.getAllFundingGrowth(
                    openOrder.lowerTick,
                    openOrder.upperTick,
                    UniswapV3Broker.getTick(params.pool),
                    params.globalFundingGrowth.twPremiumX96,
                    params.globalFundingGrowth.twPremiumDivBySqrtPriceX96
                );
            openOrder.lastTwPremiumGrowthInsideX96 = fundingGrowthRangeInfo.twPremiumGrowthInsideX96;
            openOrder.lastTwPremiumGrowthBelowX96 = fundingGrowthRangeInfo.twPremiumGrowthBelowX96;
            openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96 = fundingGrowthRangeInfo
                .twPremiumDivBySqrtPriceGrowthInsideX96;
        } else {
            feeGrowthInsideX128 = tickMap.getFeeGrowthInsideX128(
                params.lowerTick,
                params.upperTick,
                UniswapV3Broker.getTick(params.pool),
                params.feeGrowthGlobalX128
            );
            fee = _calcOwedFee(openOrder.liquidity, feeGrowthInsideX128, openOrder.lastFeeGrowthInsideX128);
        }

        // update open order with new liquidity
        openOrder.liquidity = openOrder.liquidity.add(params.liquidity).toUint128();
        openOrder.lastFeeGrowthInsideX128 = feeGrowthInsideX128;

        return fee;
    }

    //
    // INTERNAL VIEW
    //

    /// @dev Get total amount of the specified tokens in the specified pool.
    ///      Note:
    ///        1. when querying quote amount, it includes Exchange fees, i.e.:
    ///           quote amount = quote liquidity + fees
    ///           base amount = base liquidity
    ///        2. quote/base liquidity does NOT include Uniswap pool fees since
    ///           they do not have any impact to our margin system
    function _getTotalTokenAmountInPool(
        address trader,
        address baseToken, // this argument is only for specifying which pool to get base or quote amounts
        bool fetchBase // true: fetch base amount, false: fetch quote amount
    ) internal view returns (uint256 tokenAmount) {
        bytes32[] memory orderIds = _openOrderIdsMap[trader][baseToken];

        //
        // tick:    lower             upper
        //       -|---+-----------------+---|--
        //     case 1                    case 2
        //
        // if current price < upper tick, maker has base
        // case 1 : current price < lower tick
        //  --> maker only has base token
        //
        // if current price > lower tick, maker has quote
        // case 2 : current price > upper tick
        //  --> maker only has quote token
        uint160 sqrtMarkPriceX96 =
            UniswapV3Broker.getSqrtMarkPriceX96(MarketRegistry(marketRegistry).getPool(baseToken));
        for (uint256 i = 0; i < orderIds.length; i++) {
            OpenOrder memory order = _openOrderMap[orderIds[i]];

            uint256 amount;
            {
                uint160 sqrtPriceAtLowerTick = TickMath.getSqrtRatioAtTick(order.lowerTick);
                uint160 sqrtPriceAtUpperTick = TickMath.getSqrtRatioAtTick(order.upperTick);
                if (fetchBase && sqrtMarkPriceX96 < sqrtPriceAtUpperTick) {
                    amount = LiquidityAmounts.getAmount0ForLiquidity(
                        sqrtMarkPriceX96 > sqrtPriceAtLowerTick ? sqrtMarkPriceX96 : sqrtPriceAtLowerTick,
                        sqrtPriceAtUpperTick,
                        order.liquidity
                    );
                } else if (!fetchBase && sqrtMarkPriceX96 > sqrtPriceAtLowerTick) {
                    amount = LiquidityAmounts.getAmount1ForLiquidity(
                        sqrtPriceAtLowerTick,
                        sqrtMarkPriceX96 < sqrtPriceAtUpperTick ? sqrtMarkPriceX96 : sqrtPriceAtUpperTick,
                        order.liquidity
                    );
                }
            }
            tokenAmount = tokenAmount.add(amount);

            if (!fetchBase) {
                // get uncollected fee (only quote)

                mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[baseToken];
                uint256 feeGrowthGlobalX128 = _feeGrowthGlobalX128Map[baseToken];
                uint256 feeGrowthInsideX128 =
                    tickMap.getFeeGrowthInsideX128(
                        order.lowerTick,
                        order.upperTick,
                        TickMath.getTickAtSqrtRatio(sqrtMarkPriceX96),
                        feeGrowthGlobalX128
                    );

                tokenAmount = tokenAmount.add(
                    _calcOwedFee(order.liquidity, feeGrowthInsideX128, order.lastFeeGrowthInsideX128)
                );
            }
        }
    }

    /// @dev the funding payment of an order/liquidity is composed of
    ///      1. funding accrued inside the range 2. funding accrued below the range
    ///      there is no funding when the price goes above the range, as liquidity is all swapped into quoteToken
    /// @return liquidityCoefficientInFundingPayment the funding payment of an order/liquidity
    function _getLiquidityCoefficientInFundingPaymentByOrder(
        OpenOrder memory order,
        Tick.FundingGrowthRangeInfo memory fundingGrowthRangeInfo
    ) internal pure returns (int256) {
        uint160 sqrtPriceX96AtUpperTick = TickMath.getSqrtRatioAtTick(order.upperTick);

        // base amount below the range
        uint256 baseAmountBelow =
            LiquidityAmounts.getAmount0ForLiquidity(
                TickMath.getSqrtRatioAtTick(order.lowerTick),
                sqrtPriceX96AtUpperTick,
                order.liquidity
            );
        // funding below the range
        int256 fundingBelowX96 =
            baseAmountBelow.toInt256().mul(
                fundingGrowthRangeInfo.twPremiumGrowthBelowX96.sub(order.lastTwPremiumGrowthBelowX96)
            );

        // funding inside the range =
        // liquidity * (ΔtwPremiumDivBySqrtPriceGrowthInsideX96 - ΔtwPremiumGrowthInsideX96 / sqrtPriceAtUpperTick)
        int256 fundingInsideX96 =
            order.liquidity.toInt256().mul(
                // ΔtwPremiumDivBySqrtPriceGrowthInsideX96
                fundingGrowthRangeInfo
                    .twPremiumDivBySqrtPriceGrowthInsideX96
                    .sub(order.lastTwPremiumDivBySqrtPriceGrowthInsideX96)
                    .sub(
                    // ΔtwPremiumGrowthInsideX96
                    (
                        fundingGrowthRangeInfo.twPremiumGrowthInsideX96.sub(order.lastTwPremiumGrowthInsideX96).mul(
                            PerpFixedPoint96.IQ96
                        )
                    )
                        .div(sqrtPriceX96AtUpperTick)
                )
            );

        return fundingBelowX96.add(fundingInsideX96).div(PerpFixedPoint96.IQ96);
    }

    /// @dev CANNOT use safeMath for feeGrowthInside calculation, as it can be extremely large and overflow
    /// @dev the difference between two feeGrowthInside, however, is correct and won't be affected by overflow or not
    function _calcOwedFee(
        uint128 liquidity,
        uint256 newFeeGrowthInside,
        uint256 oldFeeGrowthInside
    ) internal pure returns (uint256) {
        return FullMath.mulDiv(newFeeGrowthInside - oldFeeGrowthInside, liquidity, FixedPoint128.Q128);
    }
}
