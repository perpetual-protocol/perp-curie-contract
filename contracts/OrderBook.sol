// SPDX-License-Identifier: GPL-3.0-or-later
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
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { PerpFixedPoint96 } from "./lib/PerpFixedPoint96.sol";
import { Funding } from "./lib/Funding.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { Tick } from "./lib/Tick.sol";
import { ClearingHouseCallee } from "./base/ClearingHouseCallee.sol";
import { UniswapV3CallbackBridge } from "./base/UniswapV3CallbackBridge.sol";
import { IMarketRegistry } from "./interface/IMarketRegistry.sol";
import { OrderBookStorageV1 } from "./storage/OrderBookStorage.sol";
import { IOrderBook } from "./interface/IOrderBook.sol";
import { OpenOrder } from "./lib/OpenOrder.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract OrderBook is
    IOrderBook,
    IUniswapV3MintCallback,
    ClearingHouseCallee,
    UniswapV3CallbackBridge,
    OrderBookStorageV1
{
    using SafeMathUpgradeable for uint256;
    using SafeMathUpgradeable for uint128;
    using SignedSafeMathUpgradeable for int256;
    using PerpMath for uint256;
    using PerpMath for uint160;
    using PerpMath for int256;
    using PerpMath for int128;
    using PerpSafeCast for uint256;
    using PerpSafeCast for uint128;
    using PerpSafeCast for int256;
    using Tick for mapping(int24 => Tick.GrowthInfo);

    //
    // STRUCT
    //

    struct InternalAddLiquidityToOrderParams {
        address maker;
        address baseToken;
        address pool;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthGlobalX128;
        uint128 liquidity;
        uint256 base;
        uint256 quote;
        Funding.Growth globalFundingGrowth;
    }

    struct InternalRemoveLiquidityParams {
        address maker;
        address baseToken;
        address pool;
        bytes32 orderId;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
    }

    struct InternalSwapStep {
        uint160 initialSqrtPriceX96;
        int24 nextTick;
        bool isNextTickInitialized;
        uint160 nextSqrtPriceX96;
        uint256 amountIn;
        uint256 amountOut;
        uint256 fee;
    }

    //
    // EXTERNAL NON-VIEW
    //

    function initialize(address marketRegistryArg) external initializer {
        __ClearingHouseCallee_init();
        __UniswapV3CallbackBridge_init(marketRegistryArg);
    }

    function setExchange(address exchangeArg) external onlyOwner {
        _exchange = exchangeArg;
        emit ExchangeChanged(exchangeArg);
    }

    /// @inheritdoc IOrderBook
    function addLiquidity(AddLiquidityParams calldata params) external override returns (AddLiquidityResponse memory) {
        _requireOnlyClearingHouse();
        address pool = IMarketRegistry(_marketRegistry).getPool(params.baseToken);
        uint256 feeGrowthGlobalX128 = _feeGrowthGlobalX128Map[params.baseToken];
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[params.baseToken];
        UniswapV3Broker.AddLiquidityResponse memory response;

        {
            bool initializedBeforeLower = UniswapV3Broker.getIsTickInitialized(pool, params.lowerTick);
            bool initializedBeforeUpper = UniswapV3Broker.getIsTickInitialized(pool, params.upperTick);

            // add liquidity to pool
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

            (, int24 currentTick, , , , , ) = UniswapV3Broker.getSlot0(pool);
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

        // state changes; if adding liquidity to an existing order, get fees accrued
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
                    base: response.base,
                    quote: response.quote,
                    globalFundingGrowth: params.fundingGrowthGlobal
                })
            );

        return
            AddLiquidityResponse({
                base: response.base,
                quote: response.quote,
                fee: fee,
                liquidity: response.liquidity
            });
    }

    /// @inheritdoc IOrderBook
    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        override
        returns (RemoveLiquidityResponse memory)
    {
        _requireOnlyClearingHouse();
        address pool = IMarketRegistry(_marketRegistry).getPool(params.baseToken);
        bytes32 orderId = OpenOrder.calcOrderKey(params.maker, params.baseToken, params.lowerTick, params.upperTick);
        return
            _removeLiquidity(
                InternalRemoveLiquidityParams({
                    maker: params.maker,
                    baseToken: params.baseToken,
                    pool: pool,
                    orderId: orderId,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    liquidity: params.liquidity
                })
            );
    }

    /// @inheritdoc IOrderBook
    function updateFundingGrowthAndLiquidityCoefficientInFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory fundingGrowthGlobal
    ) external override returns (int256 liquidityCoefficientInFundingPayment) {
        _requireOnlyExchange();

        bytes32[] memory orderIds = _openOrderIdsMap[trader][baseToken];
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[baseToken];
        address pool = IMarketRegistry(_marketRegistry).getPool(baseToken);

        // funding of liquidity coefficient
        uint256 orderIdLength = orderIds.length;
        (, int24 tick, , , , , ) = UniswapV3Broker.getSlot0(pool);
        for (uint256 i = 0; i < orderIdLength; i++) {
            OpenOrder.Info storage order = _openOrderMap[orderIds[i]];
            Tick.FundingGrowthRangeInfo memory fundingGrowthRangeInfo =
                tickMap.getAllFundingGrowth(
                    order.lowerTick,
                    order.upperTick,
                    tick,
                    fundingGrowthGlobal.twPremiumX96,
                    fundingGrowthGlobal.twPremiumDivBySqrtPriceX96
                );

            // the calculation here is based on cached values
            liquidityCoefficientInFundingPayment = liquidityCoefficientInFundingPayment.add(
                Funding.calcLiquidityCoefficientInFundingPaymentByOrder(order, fundingGrowthRangeInfo)
            );

            // thus, state updates have to come after
            order.lastTwPremiumGrowthInsideX96 = fundingGrowthRangeInfo.twPremiumGrowthInsideX96;
            order.lastTwPremiumGrowthBelowX96 = fundingGrowthRangeInfo.twPremiumGrowthBelowX96;
            order.lastTwPremiumDivBySqrtPriceGrowthInsideX96 = fundingGrowthRangeInfo
                .twPremiumDivBySqrtPriceGrowthInsideX96;
        }

        return liquidityCoefficientInFundingPayment;
    }

    /// @inheritdoc IOrderBook
    function updateOrderDebt(
        bytes32 orderId,
        int256 base,
        int256 quote
    ) external override {
        _requireOnlyClearingHouse();
        OpenOrder.Info storage openOrder = _openOrderMap[orderId];
        openOrder.baseDebt = openOrder.baseDebt.toInt256().add(base).toUint256();
        openOrder.quoteDebt = openOrder.quoteDebt.toInt256().add(quote).toUint256();
    }

    /// @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override checkCallback {
        IUniswapV3MintCallback(_clearingHouse).uniswapV3MintCallback(amount0Owed, amount1Owed, data);
    }

    /// @inheritdoc IOrderBook
    function replaySwap(ReplaySwapParams memory params) external override returns (ReplaySwapResponse memory) {
        _requireOnlyExchange();

        bool isExactInput = params.amount > 0;
        uint256 fee;
        uint256 insuranceFundFee; // insuranceFundFee = fee * insuranceFundFeeRatio

        UniswapV3Broker.SwapState memory swapState =
            UniswapV3Broker.getSwapState(params.pool, params.amount, _feeGrowthGlobalX128Map[params.baseToken]);

        params.sqrtPriceLimitX96 = params.sqrtPriceLimitX96 == 0
            ? (params.isBaseToQuote ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
            : params.sqrtPriceLimitX96;

        // if there is residue in amountSpecifiedRemaining, makers can get a tiny little bit less than expected,
        // which is safer for the system
        int24 tickSpacing = UniswapV3Broker.getTickSpacing(params.pool);

        while (swapState.amountSpecifiedRemaining != 0 && swapState.sqrtPriceX96 != params.sqrtPriceLimitX96) {
            InternalSwapStep memory step;
            step.initialSqrtPriceX96 = swapState.sqrtPriceX96;

            // find next tick
            // note the search is bounded in one word
            (step.nextTick, step.isNextTickInitialized) = UniswapV3Broker.getNextInitializedTickWithinOneWord(
                params.pool,
                swapState.tick,
                tickSpacing,
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
            (swapState.sqrtPriceX96, step.amountIn, step.amountOut, step.fee) = SwapMath.computeSwapStep(
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
                swapState.amountSpecifiedRemaining = swapState.amountSpecifiedRemaining.sub(
                    step.amountIn.add(step.fee).toInt256()
                );
            } else {
                swapState.amountSpecifiedRemaining = swapState.amountSpecifiedRemaining.add(step.amountOut.toInt256());
            }

            // update CH's global fee growth if there is liquidity in this range
            // note CH only collects quote fee when swapping base -> quote
            if (swapState.liquidity > 0) {
                if (params.isBaseToQuote) {
                    step.fee = FullMath.mulDivRoundingUp(step.amountOut, params.exchangeFeeRatio, 1e6);
                }

                fee += step.fee;
                uint256 stepInsuranceFundFee = FullMath.mulDivRoundingUp(step.fee, params.insuranceFundFeeRatio, 1e6);
                insuranceFundFee += stepInsuranceFundFee;
                uint256 stepMakerFee = step.fee.sub(stepInsuranceFundFee);
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

                    int128 liquidityNet = UniswapV3Broker.getTickLiquidityNet(params.pool, step.nextTick);
                    if (params.isBaseToQuote) liquidityNet = liquidityNet.neg128();
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

        return ReplaySwapResponse({ tick: swapState.tick, fee: fee, insuranceFundFee: insuranceFundFee });
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc IOrderBook
    function getExchange() external view override returns (address) {
        return _exchange;
    }

    /// @inheritdoc IOrderBook
    function getOpenOrderIds(address trader, address baseToken) external view override returns (bytes32[] memory) {
        return _openOrderIdsMap[trader][baseToken];
    }

    /// @inheritdoc IOrderBook
    function getOpenOrderById(bytes32 orderId) external view override returns (OpenOrder.Info memory) {
        return _openOrderMap[orderId];
    }

    /// @inheritdoc IOrderBook
    function getOpenOrder(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view override returns (OpenOrder.Info memory) {
        return _openOrderMap[OpenOrder.calcOrderKey(trader, baseToken, lowerTick, upperTick)];
    }

    /// @inheritdoc IOrderBook
    function hasOrder(address trader, address[] calldata tokens) external view override returns (bool) {
        for (uint256 i = 0; i < tokens.length; i++) {
            if (_openOrderIdsMap[trader][tokens[i]].length > 0) {
                return true;
            }
        }
        return false;
    }

    /// @inheritdoc IOrderBook
    function getTotalQuoteBalanceAndPendingFee(address trader, address[] calldata baseTokens)
        external
        view
        override
        returns (int256 totalQuoteAmountInPools, uint256 totalPendingFee)
    {
        for (uint256 i = 0; i < baseTokens.length; i++) {
            address baseToken = baseTokens[i];
            (int256 makerQuoteBalance, uint256 pendingFee) =
                _getMakerQuoteBalanceAndPendingFee(trader, baseToken, false);
            totalQuoteAmountInPools = totalQuoteAmountInPools.add(makerQuoteBalance);
            totalPendingFee = totalPendingFee.add(pendingFee);
        }
        return (totalQuoteAmountInPools, totalPendingFee);
    }

    /// @inheritdoc IOrderBook
    function getTotalTokenAmountInPoolAndPendingFee(
        address trader,
        address baseToken,
        bool fetchBase // true: fetch base amount, false: fetch quote amount
    ) external view override returns (uint256 tokenAmount, uint256 pendingFee) {
        (tokenAmount, pendingFee) = _getTotalTokenAmountInPool(trader, baseToken, fetchBase);
    }

    /// @inheritdoc IOrderBook
    function getLiquidityCoefficientInFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory fundingGrowthGlobal
    ) external view override returns (int256 liquidityCoefficientInFundingPayment) {
        bytes32[] memory orderIds = _openOrderIdsMap[trader][baseToken];
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[baseToken];
        address pool = IMarketRegistry(_marketRegistry).getPool(baseToken);

        // funding of liquidity coefficient
        (, int24 tick, , , , , ) = UniswapV3Broker.getSlot0(pool);
        for (uint256 i = 0; i < orderIds.length; i++) {
            OpenOrder.Info memory order = _openOrderMap[orderIds[i]];
            Tick.FundingGrowthRangeInfo memory fundingGrowthRangeInfo =
                tickMap.getAllFundingGrowth(
                    order.lowerTick,
                    order.upperTick,
                    tick,
                    fundingGrowthGlobal.twPremiumX96,
                    fundingGrowthGlobal.twPremiumDivBySqrtPriceX96
                );

            // the calculation here is based on cached values
            liquidityCoefficientInFundingPayment = liquidityCoefficientInFundingPayment.add(
                Funding.calcLiquidityCoefficientInFundingPaymentByOrder(order, fundingGrowthRangeInfo)
            );
        }

        return liquidityCoefficientInFundingPayment;
    }

    /// @inheritdoc IOrderBook
    function getPendingFee(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view override returns (uint256) {
        (uint256 pendingFee, ) =
            _getPendingFeeAndFeeGrowthInsideX128ByOrder(
                baseToken,
                _openOrderMap[OpenOrder.calcOrderKey(trader, baseToken, lowerTick, upperTick)]
            );
        return pendingFee;
    }

    //
    // PUBLIC VIEW
    //

    /// @inheritdoc IOrderBook
    function getTotalOrderDebt(
        address trader,
        address baseToken,
        bool fetchBase
    ) public view override returns (uint256) {
        uint256 totalOrderDebt;
        bytes32[] memory orderIds = _openOrderIdsMap[trader][baseToken];
        uint256 orderIdLength = orderIds.length;
        for (uint256 i = 0; i < orderIdLength; i++) {
            OpenOrder.Info memory orderInfo = _openOrderMap[orderIds[i]];
            uint256 orderDebt = fetchBase ? orderInfo.baseDebt : orderInfo.quoteDebt;
            totalOrderDebt = totalOrderDebt.add(orderDebt);
        }
        return totalOrderDebt;
    }

    //
    // INTERNAL NON-VIEW
    //

    function _removeLiquidity(InternalRemoveLiquidityParams memory params)
        internal
        returns (RemoveLiquidityResponse memory)
    {
        UniswapV3Broker.RemoveLiquidityResponse memory response =
            UniswapV3Broker.removeLiquidity(
                UniswapV3Broker.RemoveLiquidityParams(
                    params.pool,
                    _clearingHouse,
                    params.lowerTick,
                    params.upperTick,
                    params.liquidity
                )
            );

        // update token info based on existing open order
        (uint256 fee, uint256 baseDebt, uint256 quoteDebt) = _removeLiquidityFromOrder(params);

        int256 takerBase = response.base.toInt256().sub(baseDebt.toInt256());
        int256 takerQuote = response.quote.toInt256().sub(quoteDebt.toInt256());

        // if flipped from initialized to uninitialized, clear the tick info
        if (!UniswapV3Broker.getIsTickInitialized(params.pool, params.lowerTick)) {
            _growthOutsideTickMap[params.baseToken].clear(params.lowerTick);
        }
        if (!UniswapV3Broker.getIsTickInitialized(params.pool, params.upperTick)) {
            _growthOutsideTickMap[params.baseToken].clear(params.upperTick);
        }

        return
            RemoveLiquidityResponse({
                base: response.base,
                quote: response.quote,
                fee: fee,
                takerBase: takerBase,
                takerQuote: takerQuote
            });
    }

    function _removeLiquidityFromOrder(InternalRemoveLiquidityParams memory params)
        internal
        returns (
            uint256 fee,
            uint256 baseDebt,
            uint256 quoteDebt
        )
    {
        // update token info based on existing open order
        OpenOrder.Info storage openOrder = _openOrderMap[params.orderId];

        // as in _addLiquidityToOrder(), fee should be calculated before the states are updated
        uint256 feeGrowthInsideX128;
        (fee, feeGrowthInsideX128) = _getPendingFeeAndFeeGrowthInsideX128ByOrder(params.baseToken, openOrder);

        if (params.liquidity != 0) {
            if (openOrder.baseDebt != 0) {
                baseDebt = FullMath.mulDiv(openOrder.baseDebt, params.liquidity, openOrder.liquidity);
                openOrder.baseDebt = openOrder.baseDebt.sub(baseDebt);
            }
            if (openOrder.quoteDebt != 0) {
                quoteDebt = FullMath.mulDiv(openOrder.quoteDebt, params.liquidity, openOrder.liquidity);
                openOrder.quoteDebt = openOrder.quoteDebt.sub(quoteDebt);
            }
            openOrder.liquidity = openOrder.liquidity.sub(params.liquidity).toUint128();
        }

        // after the fee is calculated, lastFeeGrowthInsideX128 can be updated if liquidity != 0 after removing
        if (openOrder.liquidity == 0) {
            _removeOrder(params.maker, params.baseToken, params.orderId);
        } else {
            openOrder.lastFeeGrowthInsideX128 = feeGrowthInsideX128;
        }

        return (fee, baseDebt, quoteDebt);
    }

    function _removeOrder(
        address maker,
        address baseToken,
        bytes32 orderId
    ) internal {
        bytes32[] storage orderIds = _openOrderIdsMap[maker][baseToken];
        uint256 orderLen = orderIds.length;
        for (uint256 idx = 0; idx < orderLen; idx++) {
            if (orderIds[idx] == orderId) {
                // found the existing order ID
                // remove it from the array efficiently by re-ordering and deleting the last element
                if (idx != orderLen - 1) {
                    orderIds[idx] = orderIds[orderLen - 1];
                }
                orderIds.pop();
                delete _openOrderMap[orderId];
                break;
            }
        }
    }

    /// @dev this function is extracted from and only used by addLiquidity() to avoid stack too deep error
    function _addLiquidityToOrder(InternalAddLiquidityToOrderParams memory params) internal returns (uint256) {
        bytes32 orderId = OpenOrder.calcOrderKey(params.maker, params.baseToken, params.lowerTick, params.upperTick);
        // get the struct by key, no matter it's a new or existing order
        OpenOrder.Info storage openOrder = _openOrderMap[orderId];

        // initialization for a new order
        if (openOrder.liquidity == 0) {
            bytes32[] storage orderIds = _openOrderIdsMap[params.maker][params.baseToken];
            // OB_ONE: orders number exceeds
            require(orderIds.length < IMarketRegistry(_marketRegistry).getMaxOrdersPerMarket(), "OB_ONE");

            // state changes
            orderIds.push(orderId);
            openOrder.lowerTick = params.lowerTick;
            openOrder.upperTick = params.upperTick;

            (, int24 tick, , , , , ) = UniswapV3Broker.getSlot0(params.pool);
            mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[params.baseToken];
            Tick.FundingGrowthRangeInfo memory fundingGrowthRangeInfo =
                tickMap.getAllFundingGrowth(
                    openOrder.lowerTick,
                    openOrder.upperTick,
                    tick,
                    params.globalFundingGrowth.twPremiumX96,
                    params.globalFundingGrowth.twPremiumDivBySqrtPriceX96
                );
            openOrder.lastTwPremiumGrowthInsideX96 = fundingGrowthRangeInfo.twPremiumGrowthInsideX96;
            openOrder.lastTwPremiumGrowthBelowX96 = fundingGrowthRangeInfo.twPremiumGrowthBelowX96;
            openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96 = fundingGrowthRangeInfo
                .twPremiumDivBySqrtPriceGrowthInsideX96;
        }

        // fee should be calculated before the states are updated, as for
        // - a new order, there is no fee accrued yet
        // - an existing order, fees accrued have to be settled before more liquidity is added
        (uint256 fee, uint256 feeGrowthInsideX128) =
            _getPendingFeeAndFeeGrowthInsideX128ByOrder(params.baseToken, openOrder);

        // after the fee is calculated, liquidity & lastFeeGrowthInsideX128 can be updated
        openOrder.liquidity = openOrder.liquidity.add(params.liquidity).toUint128();
        openOrder.lastFeeGrowthInsideX128 = feeGrowthInsideX128;
        openOrder.baseDebt = openOrder.baseDebt.add(params.base);
        openOrder.quoteDebt = openOrder.quoteDebt.add(params.quote);

        return fee;
    }

    //
    // INTERNAL VIEW
    //

    /// @return makerBalance maker quote balance
    /// @return pendingFee pending fee
    function _getMakerQuoteBalanceAndPendingFee(
        address trader,
        address baseToken,
        bool fetchBase
    ) internal view returns (int256 makerBalance, uint256 pendingFee) {
        (uint256 totalBalanceFromOrders, uint256 pendingFee) = _getTotalTokenAmountInPool(trader, baseToken, fetchBase);
        uint256 totalOrderDebt = getTotalOrderDebt(trader, baseToken, fetchBase);

        // makerBalance = totalTokenAmountInPool - totalOrderDebt
        return (totalBalanceFromOrders.toInt256().sub(totalOrderDebt.toInt256()), pendingFee);
    }

    /// @dev Get total amount of the specified tokens in the specified pool.
    ///      Note:
    ///        1. when querying quote amount, it includes Exchange fees, i.e.:
    ///           quote amount = quote liquidity + fees
    ///           base amount = base liquidity
    ///        2. quote/base liquidity does NOT include Uniswap pool fees since
    ///           they do not have any impact to our margin system
    ///        3. the returned fee amount is only meaningful when querying quote amount
    function _getTotalTokenAmountInPool(
        address trader,
        address baseToken, // this argument is only for specifying which pool to get base or quote amounts
        bool fetchBase // true: fetch base amount, false: fetch quote amount
    ) internal view returns (uint256 tokenAmount, uint256 pendingFee) {
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
        (uint160 sqrtMarkPriceX96, , , , , , ) =
            UniswapV3Broker.getSlot0(IMarketRegistry(_marketRegistry).getPool(baseToken));
        uint256 orderIdLength = orderIds.length;

        for (uint256 i = 0; i < orderIdLength; i++) {
            OpenOrder.Info memory order = _openOrderMap[orderIds[i]];

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

            // get uncollected fee (only quote)
            if (!fetchBase) {
                (uint256 pendingFeeInOrder, ) = _getPendingFeeAndFeeGrowthInsideX128ByOrder(baseToken, order);
                pendingFee = pendingFee.add(pendingFeeInOrder);
            }
        }
        return (tokenAmount, pendingFee);
    }

    /// @dev CANNOT use safeMath for feeGrowthInside calculation, as it can be extremely large and overflow
    ///      the difference between two feeGrowthInside, however, is correct and won't be affected by overflow or not
    function _getPendingFeeAndFeeGrowthInsideX128ByOrder(address baseToken, OpenOrder.Info memory order)
        internal
        view
        returns (uint256 pendingFee, uint256 feeGrowthInsideX128)
    {
        (, int24 tick, , , , , ) = UniswapV3Broker.getSlot0(IMarketRegistry(_marketRegistry).getPool(baseToken));
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[baseToken];
        feeGrowthInsideX128 = tickMap.getFeeGrowthInsideX128(
            order.lowerTick,
            order.upperTick,
            tick,
            _feeGrowthGlobalX128Map[baseToken]
        );
        pendingFee = FullMath.mulDiv(
            feeGrowthInsideX128 - order.lastFeeGrowthInsideX128,
            order.liquidity,
            FixedPoint128.Q128
        );

        return (pendingFee, feeGrowthInsideX128);
    }

    function _requireOnlyExchange() internal view {
        // OB_OEX: Only exchange
        require(_msgSender() == _exchange, "OB_OEX");
    }
}
