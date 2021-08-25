// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Tick } from "./lib/Tick.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";
import { IUniswapV3MintCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { FixedPoint128 } from "@uniswap/v3-core/contracts/libraries/FixedPoint128.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { FeeMath } from "./lib/FeeMath.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { SwapMath } from "@uniswap/v3-core/contracts/libraries/SwapMath.sol";
import { LiquidityMath } from "@uniswap/v3-core/contracts/libraries/LiquidityMath.sol";
import { IMintableERC20 } from "./interface/IMintableERC20.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { ArbBlockContext } from "./arbitrum/ArbBlockContext.sol";
import { PerpFixedPoint96 } from "./lib/PerpFixedPoint96.sol";
import { Funding } from "./lib/Funding.sol";
import { PerpMath } from "./lib/PerpMath.sol";

contract Exchange is IUniswapV3MintCallback, IUniswapV3SwapCallback, Ownable, ArbBlockContext {
    using SafeMath for uint256;
    using SignedSafeMath for int256;
    using PerpMath for uint256;
    using PerpMath for int256;
    using PerpMath for uint160;
    using PerpSafeCast for uint256;
    using PerpSafeCast for uint128;
    using PerpSafeCast for int256;
    using Tick for mapping(int24 => Tick.GrowthInfo);

    struct AddLiquidityToOrderParams {
        address maker;
        address baseToken;
        address pool;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthGlobalClearingHouseX128;
        uint256 feeGrowthInsideQuoteX128;
        uint256 liquidity;
        Funding.Growth globalFundingGrowth;
    }

    /// @param feeGrowthInsideClearingHouseLastX128 there is only quote fee in ClearingHouse
    struct OpenOrder {
        uint128 liquidity;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthInsideClearingHouseLastX128;
        int256 lastTwPremiumGrowthInsideX96;
        int256 lastTwPremiumGrowthBelowX96;
        int256 lastTwPremiumDivBySqrtPriceGrowthInsideX96;
    }

    struct TickStatus {
        int24 finalTickFromLastBlock;
        uint256 lastUpdatedBlock;
    }

    struct PriceLimitParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96;
    }

    // TODO can remove pool once we move addPool to Exchange
    // TODO can remove quotteToken once we add quoteToken to constructor
    struct AddLiquidityParams {
        address trader;
        address baseToken;
        uint256 base;
        uint256 quote;
        int24 lowerTick;
        int24 upperTick;
        uint256 minBase;
        uint256 minQuote;
        Funding.Growth updatedGlobalFundingGrowth;
    }

    struct AddLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
        uint128 liquidity;
    }

    struct InternalSwapState {
        address pool;
        uint24 clearingHouseFeeRatio;
        uint24 uniswapFeeRatio;
        uint256 fee;
        uint256 insuranceFundFee;
    }

    struct SwapParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        Funding.Growth updatedGlobalFundingGrowth;
        bool mintForTrader; // TODO delet
    }

    struct SwapResponse {
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        uint256 fee;
        uint256 insuranceFundFee;
    }

    function setFeeRatio(address baseToken, uint24 feeRatio) external {
        _clearingHouseFeeRatioMap[_poolMap[baseToken]] = feeRatio;
    }

    struct SwapCallbackData {
        address trader;
        address baseToken;
        bool mintForTrader;
        uint24 uniswapFeeRatio;
        uint256 fee;
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

    struct RemoveLiquidityFromOrderParams {
        address maker;
        address baseToken;
        address pool;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthInsideQuoteX128;
        uint256 liquidity;
    }

    struct SwapState {
        int24 tick;
        uint160 sqrtPriceX96;
        int256 amountSpecifiedRemaining;
        uint256 feeGrowthGlobalX128;
        uint128 liquidity;
    }

    struct ReplaySwapParams {
        SwapState state;
        address baseToken;
        bool isBaseToQuote;
        bool shouldUpdateState;
        uint160 sqrtPriceLimitX96;
        uint24 clearingHouseFeeRatio;
        uint24 uniswapFeeRatio;
        Funding.Growth globalFundingGrowth;
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

    address public immutable quoteToken;
    address public immutable uniswapV3Factory;
    address public clearingHouse;
    uint8 public maxOrdersPerMarket;

    // TODO refactoring
    // key: base token, value: pool
    mapping(address => address) private _poolMap;

    // key: accountMarketId => openOrderIds
    mapping(bytes32 => bytes32[]) private _openOrderIdsMap;

    // key: openOrderId
    mapping(bytes32 => OpenOrder) private _openOrderMap;

    // first key: base token, second key: tick index
    // value: the accumulator of **Tick.GrowthInfo** outside each tick of each pool
    mapping(address => mapping(int24 => Tick.GrowthInfo)) private _growthOutsideTickMap;

    // value: the global accumulator of **quote fee transformed from base fee** of each pool
    // key: base token, value: pool
    mapping(address => uint256) private _feeGrowthGlobalX128Map;

    // key: base token. a threshold to limit the price impact per block when reducing or closing the position
    mapping(address => uint256) private _maxTickCrossedWithinBlockMap;

    // key: base token. tracking the final tick from last block
    // will be used for comparing if it exceeds maxTickCrossedWithinBlock
    mapping(address => TickStatus) private _tickStatusMap;

    // uniswapFeeRatioMap cache only
    mapping(address => uint24) public uniswapFeeRatioMap;

    // TODO rename to exchangeFeeRatio
    mapping(address => uint24) private _clearingHouseFeeRatioMap;
    mapping(address => uint24) private _insuranceFundFeeRatioMap;

    //
    // MODIFIERS
    //
    modifier onlyClearingHouse() {
        // only ClearingHouse
        require(_msgSender() == clearingHouse, "E_OCH");
        _;
    }

    constructor(
        address clearingHouseArg,
        address uniswapV3FactoryArg,
        address quoteTokenArg,
        uint8 maxOrdersPerMarketArg
    ) {
        // TODO check zero
        clearingHouse = clearingHouseArg;
        uniswapV3Factory = uniswapV3FactoryArg;
        quoteToken = quoteTokenArg;
        maxOrdersPerMarket = maxOrdersPerMarketArg;
    }

    //
    // EXTERNAL FUNCTIONS
    //

    function setMaxOrdersPerMarket(uint8 maxOrdersPerMarketArg) external {
        maxOrdersPerMarket = maxOrdersPerMarketArg;
    }

    function setInsuranceFundFeeRatio(address baseToken, uint24 insuranceFundFeeRatioArg) external {
        _insuranceFundFeeRatioMap[baseToken] = insuranceFundFeeRatioArg;
    }

    function setMaxTickCrossedWithinBlock(address baseToken, uint256 maxTickCrossedWithinBlock) external {
        _maxTickCrossedWithinBlockMap[baseToken] = maxTickCrossedWithinBlock;
    }

    // TODO move back to CH
    function saveTickBeforeFirstSwapThisBlock(address baseToken) external onlyClearingHouse {
        // only do this when it's the first swap in this block
        uint256 blockNumber = _blockNumber();
        if (blockNumber == _tickStatusMap[baseToken].lastUpdatedBlock) {
            return;
        }

        // the current tick before swap = final tick last block
        _tickStatusMap[baseToken] = TickStatus({
            lastUpdatedBlock: blockNumber,
            finalTickFromLastBlock: UniswapV3Broker.getTick(_poolMap[baseToken])
        });
    }

    // TODO refactoring
    function addPool(address baseToken, uint24 feeRatio) external onlyClearingHouse returns (address) {
        address pool = UniswapV3Broker.getPool(uniswapV3Factory, quoteToken, baseToken, feeRatio);
        _poolMap[baseToken] = pool;
        uniswapFeeRatioMap[pool] = feeRatio;
        _clearingHouseFeeRatioMap[pool] = feeRatio;
        return pool;
    }

    function swap(SwapParams memory params) external onlyClearingHouse returns (SwapResponse memory) {
        address pool = _poolMap[params.baseToken];
        UniswapV3Broker.SwapResponse memory response;
        // InternalSwapState is simply a container of local variables to solve Stack Too Deep error
        InternalSwapState memory internalSwapState =
            InternalSwapState({
                pool: _poolMap[params.baseToken],
                clearingHouseFeeRatio: _clearingHouseFeeRatioMap[pool],
                uniswapFeeRatio: uniswapFeeRatioMap[pool],
                fee: 0,
                insuranceFundFee: 0
            });
        {
            (uint256 scaledAmount, int256 signedScaledAmount) =
                _getScaledAmount(
                    params.isBaseToQuote,
                    params.isExactInput,
                    params.amount,
                    internalSwapState.clearingHouseFeeRatio,
                    internalSwapState.uniswapFeeRatio
                );
            SwapState memory state =
                SwapState({
                    tick: UniswapV3Broker.getTick(internalSwapState.pool),
                    sqrtPriceX96: UniswapV3Broker.getSqrtMarkPriceX96(internalSwapState.pool),
                    amountSpecifiedRemaining: signedScaledAmount,
                    feeGrowthGlobalX128: _feeGrowthGlobalX128Map[params.baseToken],
                    liquidity: UniswapV3Broker.getLiquidity(internalSwapState.pool)
                });
            // simulate the swap to calculate the fees charged in clearing house
            (internalSwapState.fee, internalSwapState.insuranceFundFee, ) = _replaySwap(
                ReplaySwapParams({
                    state: state,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    shouldUpdateState: true,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    clearingHouseFeeRatio: internalSwapState.clearingHouseFeeRatio,
                    uniswapFeeRatio: internalSwapState.uniswapFeeRatio,
                    globalFundingGrowth: params.updatedGlobalFundingGrowth
                })
            );
            response = UniswapV3Broker.swap(
                UniswapV3Broker.SwapParams(
                    internalSwapState.pool,
                    params.isBaseToQuote,
                    params.isExactInput,
                    // mint extra base token before swap
                    scaledAmount,
                    params.sqrtPriceLimitX96,
                    abi.encode(
                        SwapCallbackData(
                            params.trader,
                            params.baseToken,
                            params.mintForTrader,
                            uniswapFeeRatioMap[pool],
                            internalSwapState.fee
                        )
                    )
                )
            );

            // TODO avoid this
            // 1. mint/burn in exchange (but swapCallback has some tokenInfo logic, need to update swap's return
            address outputToken = params.isBaseToQuote ? quoteToken : params.baseToken;
            uint256 outputAmount = params.isBaseToQuote ? response.quote : response.base;
            TransferHelper.safeTransfer(outputToken, clearingHouse, outputAmount);
        }

        // because we charge fee in CH instead of uniswap pool,
        // we need to scale up base or quote amount to get exact exchanged position size and notional
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        if (params.isBaseToQuote) {
            // short: exchangedPositionSize <= 0 && exchangedPositionNotional >= 0
            exchangedPositionSize = -(
                FeeMath.calcScaledAmount(response.base, internalSwapState.uniswapFeeRatio, false).toInt256()
            );
            // due to base to quote fee, exchangedPositionNotional contains the fee
            // s.t. we can take the fee away from exchangedPositionNotional(exchangedPositionNotional)
            exchangedPositionNotional = response.quote.toInt256();
        } else {
            // long: exchangedPositionSize >= 0 && exchangedPositionNotional <= 0
            exchangedPositionSize = response.base.toInt256();
            exchangedPositionNotional = -(
                FeeMath.calcScaledAmount(response.quote, internalSwapState.uniswapFeeRatio, false).toInt256()
            );
        }

        return
            SwapResponse({
                exchangedPositionSize: exchangedPositionSize,
                exchangedPositionNotional: exchangedPositionNotional,
                fee: internalSwapState.fee,
                insuranceFundFee: internalSwapState.insuranceFundFee
            });
    }

    function addLiquidity(AddLiquidityParams calldata params)
        external
        onlyClearingHouse
        returns (AddLiquidityResponse memory)
    {
        address pool = _poolMap[params.baseToken];
        uint256 feeGrowthGlobalClearingHouseX128 = _feeGrowthGlobalX128Map[params.baseToken];
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[params.baseToken];
        UniswapV3Broker.AddLiquidityResponse memory response;

        {
            bool initializedBeforeLower = UniswapV3Broker.getIsTickInitialized(pool, params.lowerTick);
            bool initializedBeforeUpper = UniswapV3Broker.getIsTickInitialized(pool, params.upperTick);

            // add liquidity to liquidity pool
            response = UniswapV3Broker.addLiquidity(
                UniswapV3Broker.AddLiquidityParams(
                    pool,
                    params.baseToken,
                    quoteToken,
                    params.lowerTick,
                    params.upperTick,
                    params.base,
                    params.quote
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
                        feeGrowthGlobalClearingHouseX128,
                        params.updatedGlobalFundingGrowth.twPremiumX96,
                        params.updatedGlobalFundingGrowth.twPremiumDivBySqrtPriceX96
                    )
                );
            }
            if (!initializedBeforeUpper && UniswapV3Broker.getIsTickInitialized(pool, params.upperTick)) {
                tickMap.initialize(
                    params.upperTick,
                    currentTick,
                    Tick.GrowthInfo(
                        feeGrowthGlobalClearingHouseX128,
                        params.updatedGlobalFundingGrowth.twPremiumX96,
                        params.updatedGlobalFundingGrowth.twPremiumDivBySqrtPriceX96
                    )
                );
            }
        }

        // price slippage check
        require(response.base >= params.minBase && response.quote >= params.minQuote, "CH_PSC");

        // mutate states
        uint256 fee =
            _addLiquidityToOrder(
                AddLiquidityToOrderParams({
                    maker: params.trader,
                    baseToken: params.baseToken,
                    pool: pool,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    feeGrowthGlobalClearingHouseX128: feeGrowthGlobalClearingHouseX128,
                    feeGrowthInsideQuoteX128: response.feeGrowthInsideQuoteX128,
                    liquidity: response.liquidity.toUint256(),
                    globalFundingGrowth: params.updatedGlobalFundingGrowth
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

    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        onlyClearingHouse
        returns (RemoveLiquidityResponse memory)
    {
        // load existing open order
        bytes32 orderId = _getOrderId(params.maker, params.baseToken, params.lowerTick, params.upperTick);
        OpenOrder storage openOrder = _openOrderMap[orderId];
        // CH_ZL non-existent openOrder
        require(openOrder.liquidity > 0, "CH_NEO");
        // CH_NEL not enough liquidity
        require(params.liquidity <= openOrder.liquidity, "CH_NEL");

        address pool = _poolMap[params.baseToken];
        UniswapV3Broker.RemoveLiquidityResponse memory response =
            UniswapV3Broker.removeLiquidity(
                UniswapV3Broker.RemoveLiquidityParams(pool, params.lowerTick, params.upperTick, params.liquidity)
            );

        // update token info based on existing open order
        uint256 fee =
            _removeLiquidityFromOrder(
                RemoveLiquidityFromOrderParams({
                    maker: params.maker,
                    baseToken: params.baseToken,
                    pool: pool,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    feeGrowthInsideQuoteX128: response.feeGrowthInsideQuoteX128,
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

        // TODO avoid this
        TransferHelper.safeTransfer(params.baseToken, clearingHouse, response.base);
        TransferHelper.safeTransfer(quoteToken, clearingHouse, response.quote);

        return RemoveLiquidityResponse({ base: response.base, quote: response.quote, fee: fee });
    }

    function getPendingFundingPaymentAndUpdateLastFundingGrowth(
        address trader,
        address baseToken,
        Funding.Growth memory updatedGlobalFundingGrowth
    ) external onlyClearingHouse returns (int256 liquidityCoefficientInFundingPayment) {
        bytes32[] memory orderIds = _openOrderIdsMap[_getAccountMarketId(trader, baseToken)];
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[baseToken];

        // update funding of liquidity
        for (uint256 i = 0; i < orderIds.length; i++) {
            OpenOrder storage order = _openOrderMap[orderIds[i]];
            Tick.FundingGrowthRangeInfo memory fundingGrowthRangeInfo =
                tickMap.getAllFundingGrowth(
                    order.lowerTick,
                    order.upperTick,
                    UniswapV3Broker.getTick(_poolMap[baseToken]),
                    updatedGlobalFundingGrowth.twPremiumX96,
                    updatedGlobalFundingGrowth.twPremiumDivBySqrtPriceX96
                );

            // the calculation here is based on cached values
            liquidityCoefficientInFundingPayment = liquidityCoefficientInFundingPayment.add(
                _getLiquidityCoefficientInFundingPayment(order, fundingGrowthRangeInfo)
            );

            // thus, state updates have to come after
            order.lastTwPremiumGrowthInsideX96 = fundingGrowthRangeInfo.twPremiumGrowthInsideX96;
            order.lastTwPremiumGrowthBelowX96 = fundingGrowthRangeInfo.twPremiumGrowthBelowX96;
            order.lastTwPremiumDivBySqrtPriceGrowthInsideX96 = fundingGrowthRangeInfo
                .twPremiumDivBySqrtPriceGrowthInsideX96;
        }
    }

    // or just deal with the vToken in Exchange
    // @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        address baseToken = abi.decode(data, (address));
        address pool = _poolMap[baseToken];
        // CH_FSV: failed mintCallback verification
        require(_msgSender() == address(pool), "E_FMV");

        IUniswapV3MintCallback(clearingHouse).uniswapV3MintCallback(amount0Owed, amount1Owed, data);
    }

    // @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        SwapCallbackData memory callbackData = abi.decode(data, (SwapCallbackData));
        IUniswapV3Pool pool = IUniswapV3Pool(_poolMap[callbackData.baseToken]);
        // CH_FSV: failed swapCallback verification
        require(_msgSender() == address(pool), "E_FSV");

        IUniswapV3SwapCallback(clearingHouse).uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    function isOverPriceLimit(PriceLimitParams memory params) external returns (bool) {
        uint256 maxTickDelta = _maxTickCrossedWithinBlockMap[params.baseToken];
        if (maxTickDelta == 0) {
            return false;
        }

        int256 tickLastBlock = _tickStatusMap[params.baseToken].finalTickFromLastBlock;
        int256 upperTickBound = tickLastBlock.add(maxTickDelta.toInt256());
        int256 lowerTickBound = tickLastBlock.sub(maxTickDelta.toInt256());

        address pool = _poolMap[params.baseToken];
        uint24 clearingHouseFeeRatio = _clearingHouseFeeRatioMap[pool];
        uint24 uniswapFeeRatio = uniswapFeeRatioMap[pool];
        (, int256 signedScaledAmount) =
            _getScaledAmount(
                params.isBaseToQuote,
                params.isExactInput,
                params.amount,
                clearingHouseFeeRatio,
                uniswapFeeRatio
            );
        SwapState memory state =
            SwapState({
                tick: UniswapV3Broker.getTick(pool),
                sqrtPriceX96: UniswapV3Broker.getSqrtMarkPriceX96(pool),
                amountSpecifiedRemaining: signedScaledAmount,
                feeGrowthGlobalX128: _feeGrowthGlobalX128Map[params.baseToken],
                liquidity: UniswapV3Broker.getLiquidity(pool)
            });

        // globalFundingGrowth can be empty if shouldUpdateState is false
        (, , int24 tickAfterSwap) =
            _replaySwap(
                ReplaySwapParams({
                    state: state,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    clearingHouseFeeRatio: clearingHouseFeeRatio,
                    uniswapFeeRatio: uniswapFeeRatio,
                    shouldUpdateState: false,
                    globalFundingGrowth: Funding.Growth({ twPremiumX96: 0, twPremiumDivBySqrtPriceX96: 0 })
                })
            );

        return (tickAfterSwap < lowerTickBound || tickAfterSwap > upperTickBound);
    }

    //
    // PRIVATE
    //

    function _removeLiquidityFromOrder(RemoveLiquidityFromOrderParams memory params) private returns (uint256 fee) {
        // update token info based on existing open order
        bytes32 orderId = _getOrderId(params.maker, params.baseToken, params.lowerTick, params.upperTick);
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[params.baseToken];
        OpenOrder storage openOrder = _openOrderMap[orderId];
        uint256 feeGrowthInsideClearingHouseX128 =
            tickMap.getFeeGrowthInside(
                params.lowerTick,
                params.upperTick,
                UniswapV3Broker.getTick(params.pool),
                _feeGrowthGlobalX128Map[params.baseToken]
            );
        fee = _calcOwedFee(
            openOrder.liquidity,
            feeGrowthInsideClearingHouseX128,
            openOrder.feeGrowthInsideClearingHouseLastX128
        );

        // update open order with new liquidity
        openOrder.liquidity = openOrder.liquidity.toUint256().sub(params.liquidity).toUint128();
        if (openOrder.liquidity == 0) {
            _removeOrder(params.maker, params.baseToken, orderId);
        } else {
            openOrder.feeGrowthInsideClearingHouseLastX128 = feeGrowthInsideClearingHouseX128;
        }
    }

    function _removeOrder(
        address maker,
        address baseToken,
        bytes32 orderId
    ) private {
        bytes32[] storage orderIds = _openOrderIdsMap[_getAccountMarketId(maker, baseToken)];
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

    function _addLiquidityToOrder(AddLiquidityToOrderParams memory params) private returns (uint256 fee) {
        // load existing open order
        bytes32 orderId = _getOrderId(params.maker, params.baseToken, params.lowerTick, params.upperTick);
        OpenOrder storage openOrder = _openOrderMap[orderId];

        uint256 feeGrowthInsideClearingHouseX128;
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[params.baseToken];
        if (openOrder.liquidity == 0) {
            // it's a new order
            bytes32[] storage orderIds = _openOrderIdsMap[_getAccountMarketId(params.maker, params.baseToken)];
            // CH_ONE: orders number exceeded
            require(maxOrdersPerMarket == 0 || orderIds.length < maxOrdersPerMarket, "CH_ONE");
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
            feeGrowthInsideClearingHouseX128 = tickMap.getFeeGrowthInside(
                params.lowerTick,
                params.upperTick,
                UniswapV3Broker.getTick(params.pool),
                params.feeGrowthGlobalClearingHouseX128
            );
            fee = _calcOwedFee(
                openOrder.liquidity,
                feeGrowthInsideClearingHouseX128,
                openOrder.feeGrowthInsideClearingHouseLastX128
            );
        }

        // update open order with new liquidity
        openOrder.liquidity = openOrder.liquidity.toUint256().add(params.liquidity).toUint128();
        openOrder.feeGrowthInsideClearingHouseLastX128 = feeGrowthInsideClearingHouseX128;
    }

    function _replaySwap(ReplaySwapParams memory params)
        private
        returns (
            uint256 fee, // clearingHouseFee
            uint256 insuranceFundFee, // insuranceFundFee = clearingHouseFee * insuranceFundFeeRatio
            int24 tick
        )
    {
        address pool = _poolMap[params.baseToken];
        bool isExactInput = params.state.amountSpecifiedRemaining > 0;
        uint24 insuranceFundFeeRatio = _insuranceFundFeeRatioMap[params.baseToken];

        params.sqrtPriceLimitX96 = params.sqrtPriceLimitX96 == 0
            ? (params.isBaseToQuote ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
            : params.sqrtPriceLimitX96;

        // if there is residue in amountSpecifiedRemaining, makers can get a tiny little bit less than expected,
        // which is safer for the system
        while (params.state.amountSpecifiedRemaining != 0 && params.state.sqrtPriceX96 != params.sqrtPriceLimitX96) {
            SwapStep memory step;
            step.initialSqrtPriceX96 = params.state.sqrtPriceX96;

            // find next tick
            // note the search is bounded in one word
            (step.nextTick, step.isNextTickInitialized) = UniswapV3Broker.getNextInitializedTickWithinOneWord(
                pool,
                params.state.tick,
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
            (params.state.sqrtPriceX96, step.amountIn, step.amountOut, step.feeAmount) = SwapMath.computeSwapStep(
                params.state.sqrtPriceX96,
                (
                    params.isBaseToQuote
                        ? step.nextSqrtPriceX96 < params.sqrtPriceLimitX96
                        : step.nextSqrtPriceX96 > params.sqrtPriceLimitX96
                )
                    ? params.sqrtPriceLimitX96
                    : step.nextSqrtPriceX96,
                params.state.liquidity,
                params.state.amountSpecifiedRemaining,
                // if base to quote: fee is charged on base token, so use uniswap fee ratio in calculation to
                //                   replay the swap in uniswap pool
                // if quote to base: use clearing house fee for calculation because the fee is charged
                //                   on quote token in clearing house
                params.isBaseToQuote ? params.uniswapFeeRatio : params.clearingHouseFeeRatio
            );

            // user input 1 quote:
            // quote token to uniswap ===> 1*0.98/0.99 = 0.98989899
            // fee = 0.98989899 * 2% = 0.01979798
            if (isExactInput) {
                params.state.amountSpecifiedRemaining -= (step.amountIn + step.feeAmount).toInt256();
            } else {
                params.state.amountSpecifiedRemaining += step.amountOut.toInt256();
            }

            // update CH's global fee growth if there is liquidity in this range
            // note CH only collects quote fee when swapping base -> quote
            if (params.state.liquidity > 0) {
                if (params.isBaseToQuote) {
                    step.feeAmount = FullMath.mulDivRoundingUp(step.amountOut, params.clearingHouseFeeRatio, 1e6);
                }

                fee += step.feeAmount;
                uint256 stepInsuranceFundFee = FullMath.mulDivRoundingUp(step.feeAmount, insuranceFundFeeRatio, 1e6);
                insuranceFundFee += stepInsuranceFundFee;
                uint256 stepMakerFee = step.feeAmount.sub(stepInsuranceFundFee);
                params.state.feeGrowthGlobalX128 += FullMath.mulDiv(
                    stepMakerFee,
                    FixedPoint128.Q128,
                    params.state.liquidity
                );
            }

            if (params.state.sqrtPriceX96 == step.nextSqrtPriceX96) {
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
                                feeX128: params.state.feeGrowthGlobalX128,
                                twPremiumX96: params.globalFundingGrowth.twPremiumX96,
                                twPremiumDivBySqrtPriceX96: params.globalFundingGrowth.twPremiumDivBySqrtPriceX96
                            })
                        );
                    }

                    int128 liquidityNet = UniswapV3Broker.getTickLiquidityNet(pool, step.nextTick);
                    if (params.isBaseToQuote) liquidityNet = -liquidityNet;
                    params.state.liquidity = LiquidityMath.addDelta(params.state.liquidity, liquidityNet);
                }

                params.state.tick = params.isBaseToQuote ? step.nextTick - 1 : step.nextTick;
            } else if (params.state.sqrtPriceX96 != step.initialSqrtPriceX96) {
                // update state.tick corresponding to the current price if the price has changed in this step
                params.state.tick = TickMath.getTickAtSqrtRatio(params.state.sqrtPriceX96);
            }
        }
        if (params.shouldUpdateState) {
            // update global states since swap state transitions are all done
            _feeGrowthGlobalX128Map[params.baseToken] = params.state.feeGrowthGlobalX128;
        }

        return (fee, insuranceFundFee, params.state.tick);
    }

    //
    // EXTERNAL VIEW
    //

    function getFeeRatio(address baseToken) external view returns (uint24) {
        return _clearingHouseFeeRatioMap[_poolMap[baseToken]];
    }

    function getOpenOrderIds(address trader, address baseToken) external view returns (bytes32[] memory) {
        return _openOrderIdsMap[_getAccountMarketId(trader, baseToken)];
    }

    function getOpenOrder(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view returns (OpenOrder memory) {
        return _openOrderMap[_getOrderId(trader, baseToken, lowerTick, upperTick)];
    }

    function getOpenOrderById(bytes32 orderId) external view returns (OpenOrder memory) {
        return _openOrderMap[orderId];
    }

    /// @dev funding payment belongs to realizedPnl, not token amount
    function getTotalTokenAmountInPool(
        address trader,
        address baseToken,
        uint160 sqrtMarkPriceX96,
        bool fetchBase // true: fetch base amount, false: fetch quote amount
    ) external view returns (uint256 tokenAmount) {
        bytes32[] memory orderIds = _openOrderIdsMap[_getAccountMarketId(trader, baseToken)];

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
        for (uint256 i = 0; i < orderIds.length; i++) {
            OpenOrder memory order = _openOrderMap[orderIds[i]];

            uint256 amount;
            {
                uint160 sqrtPriceAtLowerTick = TickMath.getSqrtRatioAtTick(order.lowerTick);
                uint160 sqrtPriceAtUpperTick = TickMath.getSqrtRatioAtTick(order.upperTick);
                if (fetchBase && sqrtMarkPriceX96 < sqrtPriceAtUpperTick) {
                    amount = UniswapV3Broker.getAmount0ForLiquidity(
                        sqrtMarkPriceX96 > sqrtPriceAtLowerTick ? sqrtMarkPriceX96 : sqrtPriceAtLowerTick,
                        sqrtPriceAtUpperTick,
                        order.liquidity
                    );
                } else if (!fetchBase && sqrtMarkPriceX96 > sqrtPriceAtLowerTick) {
                    amount = UniswapV3Broker.getAmount1ForLiquidity(
                        sqrtPriceAtLowerTick,
                        sqrtMarkPriceX96 < sqrtPriceAtUpperTick ? sqrtMarkPriceX96 : sqrtPriceAtUpperTick,
                        order.liquidity
                    );
                }
            }
            tokenAmount = tokenAmount.add(amount);

            if (!fetchBase) {
                int24 tick = TickMath.getTickAtSqrtRatio(sqrtMarkPriceX96);

                // uncollected quote fee in ClearingHouse
                mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[baseToken];
                uint256 feeGrowthGlobalX128 = _feeGrowthGlobalX128Map[baseToken];
                uint256 feeGrowthInsideClearingHouseX128 =
                    tickMap.getFeeGrowthInside(order.lowerTick, order.upperTick, tick, feeGrowthGlobalX128);

                tokenAmount = tokenAmount.add(
                    _calcOwedFee(
                        order.liquidity,
                        feeGrowthInsideClearingHouseX128,
                        order.feeGrowthInsideClearingHouseLastX128
                    )
                );
            }
        }
    }

    function getMaxTickCrossedWithinBlock(address baseToken) external view returns (uint256) {
        return _maxTickCrossedWithinBlockMap[baseToken];
    }

    function getTickFundingGrowthRangeInfo(
        address baseToken,
        int24 lowerTick,
        int24 upperTick,
        int256 twPremiumX96,
        int256 twPremiumDivBySqrtPriceX96
    ) external view returns (Tick.FundingGrowthRangeInfo memory fundingGrowthRangeInfo) {
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[baseToken];
        fundingGrowthRangeInfo = tickMap.getAllFundingGrowth(
            lowerTick,
            upperTick,
            UniswapV3Broker.getTick(_poolMap[baseToken]),
            twPremiumX96,
            twPremiumDivBySqrtPriceX96
        );
    }

    function getSqrtMarkTwapX96(address baseToken, uint32 twapInterval) external view returns (uint256) {
        return UniswapV3Broker.getSqrtMarkTwapX96(_poolMap[baseToken], twapInterval).formatSqrtPriceX96ToPriceX96();
    }

    function getSqrtMarkPriceX96(address baseToken) external view returns (uint160) {
        return UniswapV3Broker.getSqrtMarkPriceX96(_poolMap[baseToken]);
    }

    function getAmount0ForLiquidity(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint128 liquidity
    ) external pure returns (uint256 amount0) {
        return UniswapV3Broker.getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity);
    }

    //
    // PRIVATE VIEW
    //

    function _getLiquidityCoefficientInFundingPayment(
        Exchange.OpenOrder memory order,
        Tick.FundingGrowthRangeInfo memory fundingGrowthRangeInfo
    ) private pure returns (int256 liquidityCoefficientInFundingPayment) {
        uint160 sqrtPriceX96AtUpperTick = TickMath.getSqrtRatioAtTick(order.upperTick);

        // base amount below the range
        uint256 baseAmountBelow =
            UniswapV3Broker.getAmount0ForLiquidity(
                TickMath.getSqrtRatioAtTick(order.lowerTick),
                sqrtPriceX96AtUpperTick,
                order.liquidity
            );
        int256 fundingBelowX96 =
            baseAmountBelow.toInt256().mul(
                fundingGrowthRangeInfo.twPremiumGrowthBelowX96.sub(order.lastTwPremiumGrowthBelowX96)
            );

        // funding inside the range =
        // liquidity * (ΔtwPremiumDivBySqrtPriceGrowthInsideX96 - ΔtwPremiumGrowthInsideX96 / sqrtPriceAtUpperTick)
        int256 fundingInsideX96 =
            uint256(order.liquidity).toInt256().mul(
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

    function _getOrderId(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(address(trader), address(baseToken), lowerTick, upperTick));
    }

    function _calcOwedFee(
        uint128 liquidity,
        uint256 feeGrowthInsideNew,
        uint256 feeGrowthInsideOld
    ) private pure returns (uint256) {
        // can NOT use safeMath, feeGrowthInside could be a very large value(a negative value)
        // which causes underflow but what we want is the difference only
        return FullMath.mulDiv(feeGrowthInsideNew - feeGrowthInsideOld, liquidity, FixedPoint128.Q128);
    }

    function _getAccountMarketId(address account, address baseToken) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(account, baseToken));
    }

    function _getScaledAmount(
        bool isBaseToQuote,
        bool isExactInput,
        uint256 amount,
        uint24 clearingHouseFeeRatio,
        uint24 uniswapFeeRatio
    ) private pure returns (uint256 scaledAmount, int256 signedScaledAmount) {
        // input or output amount for swap
        // 1. Q2B && exact in  --> input quote * (1 - y) / (1 - x)
        // 2. Q2B && exact out --> output base(params.base)
        // 3. B2Q && exact in  --> input base / (1 - x)
        // 4. B2Q && exact out --> output base / (1 - y)
        scaledAmount = isBaseToQuote
            ? isExactInput
                ? FeeMath.calcScaledAmount(amount, uniswapFeeRatio, true)
                : FeeMath.calcScaledAmount(amount, clearingHouseFeeRatio, true)
            : isExactInput
            ? FeeMath.magicFactor(amount, uniswapFeeRatio, clearingHouseFeeRatio, false)
            : amount;

        // if Q2B, we use params.amount directly
        // for example, input 1 quote and x = 1%, y = 3%. Our target is to get 0.03 fee
        // we simulate the swap step in `_replaySwap`.
        // If we scale the input(1 * 0.97 / 0.99), the fee calculated in `_replaySwap` won't be 0.03.
        signedScaledAmount = isBaseToQuote
            ? isExactInput ? scaledAmount.toInt256() : -scaledAmount.toInt256()
            : isExactInput
            ? amount.toInt256()
            : -amount.toInt256();
    }
}
