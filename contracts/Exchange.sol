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
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { LiquidityAmounts } from "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";
import { ArbBlockContext } from "./arbitrum/ArbBlockContext.sol";
import { UniswapV3Broker, IUniswapV3Pool } from "./lib/UniswapV3Broker.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { FeeMath } from "./lib/FeeMath.sol";
import { PerpFixedPoint96 } from "./lib/PerpFixedPoint96.sol";
import { Funding } from "./lib/Funding.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { OrderKey } from "./lib/OrderKey.sol";
import { Tick } from "./lib/Tick.sol";
import { SafeOwnable } from "./base/SafeOwnable.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { VirtualToken } from "./VirtualToken.sol";
import { ExchangeRegistry } from "./ExchangeRegistry.sol";
import { ILiquidityAction } from "./interface/ILiquidityAction.sol";
import { OrderBook } from "./OrderBook.sol";

contract Exchange is IUniswapV3MintCallback, IUniswapV3SwapCallback, ILiquidityAction, SafeOwnable, ArbBlockContext {
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

    struct ReplaySwapParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96;
    }

    struct SwapParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        Funding.Growth fundingGrowthGlobal;
    }

    struct SwapResponse {
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        uint256 fee;
        uint256 insuranceFundFee;
        int24 tick;
    }

    struct SwapCallbackData {
        address trader;
        address baseToken;
        address pool;
        uint24 uniswapFeeRatio;
        uint256 fee;
    }

    // TODO should be immutable, check how to achieve this in oz upgradeable framework.
    address public exchangeRegistry;
    address public clearingHouse;
    address public orderBook;

    uint8 public maxOrdersPerMarket;

    function initialize(
        address clearingHouseArg,
        address exchangeRegistryArg,
        address orderBookArg
    ) external initializer {
        __SafeOwnable_init();

        // ClearingHouse is 0
        require(clearingHouseArg != address(0), "EX_CH0");
        // ExchangeRegistry is 0
        require(exchangeRegistryArg != address(0), "EX_MR0");
        // OrderBook is 0
        require(orderBookArg != address(0), "EX_OB0");

        // update states
        clearingHouse = clearingHouseArg;
        exchangeRegistry = exchangeRegistryArg;
        orderBook = orderBookArg;
    }

    //
    // MODIFIERS
    //
    modifier onlyClearingHouse() {
        // only ClearingHouse
        require(_msgSender() == clearingHouse, "EX_OCH");
        _;
    }

    //    modifier checkRatio(uint24 ratio) {
    //        // EX_RO: ratio overflow
    //        require(ratio <= 1e6, "EX_RO");
    //        _;
    //    }

    modifier checkCallback() {
        address pool = _msgSender();
        address baseToken = IUniswapV3Pool(pool).token0();
        require(pool == ExchangeRegistry(exchangeRegistry).getPool(baseToken), "EX_FCV");
        _;
    }

    //
    // EXTERNAL ADMIN FUNCTIONS
    //

    function setMaxOrdersPerMarket(uint8 maxOrdersPerMarketArg) external onlyOwner {
        ExchangeRegistry(exchangeRegistry).setMaxOrdersPerMarket(maxOrdersPerMarketArg);
    }

    ////// TODO REMOVE LATER
    function addPool(address baseToken, uint24 feeRatio) external onlyOwner returns (address) {
        ExchangeRegistry(exchangeRegistry).addPool(baseToken, feeRatio);
    }

    function setFeeRatio(address baseToken, uint24 feeRatio) external onlyOwner {
        ExchangeRegistry(exchangeRegistry).setFeeRatio(baseToken, feeRatio);
    }

    function setInsuranceFundFeeRatio(address baseToken, uint24 insuranceFundFeeRatioArg) external onlyOwner {
        ExchangeRegistry(exchangeRegistry).setInsuranceFundFeeRatio(baseToken, insuranceFundFeeRatioArg);
    }

    //////

    //
    // EXTERNAL FUNCTIONS
    //
    function swap(SwapParams memory params) external onlyClearingHouse returns (SwapResponse memory) {
        ExchangeRegistry.Info memory marketInfo = ExchangeRegistry(exchangeRegistry).getInfo(params.baseToken);

        (uint256 scaledAmountForUniswapV3PoolSwap, int256 signedScaledAmountForReplaySwap) =
            _getScaledAmountForSwaps(
                params.isBaseToQuote,
                params.isExactInput,
                params.amount,
                marketInfo.exchangeFeeRatio,
                marketInfo.uniswapFeeRatio
            );

        // simulate the swap to calculate the fees charged in exchange
        OrderBook.ReplaySwapResponse memory replayResponse =
            OrderBook(orderBook).replaySwap(
                OrderBook.InternalReplaySwapParams({
                    state: UniswapV3Broker.getSwapState(
                        marketInfo.pool,
                        signedScaledAmountForReplaySwap,
                        OrderBook(orderBook).getFeeGrowthGlobal(params.baseToken)
                    ),
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    shouldUpdateState: true,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    exchangeFeeRatio: marketInfo.exchangeFeeRatio,
                    uniswapFeeRatio: marketInfo.uniswapFeeRatio,
                    globalFundingGrowth: params.fundingGrowthGlobal
                })
            );
        UniswapV3Broker.SwapResponse memory response =
            UniswapV3Broker.swap(
                UniswapV3Broker.SwapParams(
                    marketInfo.pool,
                    clearingHouse,
                    params.isBaseToQuote,
                    params.isExactInput,
                    // mint extra base token before swap
                    scaledAmountForUniswapV3PoolSwap,
                    params.sqrtPriceLimitX96,
                    abi.encode(
                        SwapCallbackData({
                            trader: params.trader,
                            baseToken: params.baseToken,
                            pool: marketInfo.pool,
                            fee: replayResponse.fee,
                            uniswapFeeRatio: marketInfo.uniswapFeeRatio
                        })
                    )
                )
            );

        // because we charge fee in CH instead of uniswap pool,
        // we need to scale up base or quote amount to get exact exchanged position size and notional
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        if (params.isBaseToQuote) {
            // short: exchangedPositionSize <= 0 && exchangedPositionNotional >= 0
            exchangedPositionSize = -(
                FeeMath.calcAmountScaledByFeeRatio(response.base, marketInfo.uniswapFeeRatio, false).toInt256()
            );
            // due to base to quote fee, exchangedPositionNotional contains the fee
            // s.t. we can take the fee away from exchangedPositionNotional
            exchangedPositionNotional = response.quote.toInt256();
        } else {
            // long: exchangedPositionSize >= 0 && exchangedPositionNotional <= 0
            exchangedPositionSize = response.base.toInt256();
            exchangedPositionNotional = -(
                FeeMath.calcAmountScaledByFeeRatio(response.quote, marketInfo.uniswapFeeRatio, false).toInt256()
            );
        }

        return
            SwapResponse({
                exchangedPositionSize: exchangedPositionSize,
                exchangedPositionNotional: exchangedPositionNotional,
                fee: replayResponse.fee,
                insuranceFundFee: replayResponse.insuranceFundFee,
                tick: replayResponse.tick
            });
    }

    /// @inheritdoc ILiquidityAction
    function addLiquidity(AddLiquidityParams calldata params)
        external
        override
        onlyClearingHouse
        returns (AddLiquidityResponse memory)
    {
        return OrderBook(orderBook).addLiquidity(params);
    }

    /// @inheritdoc ILiquidityAction
    function removeLiquidityByIds(
        address maker,
        address baseToken,
        bytes32[] calldata orderIds
    ) external override onlyClearingHouse returns (RemoveLiquidityResponse memory) {
        return OrderBook(orderBook).removeLiquidityByIds(maker, baseToken, orderIds);
    }

    /// @inheritdoc ILiquidityAction
    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        override
        onlyClearingHouse
        returns (RemoveLiquidityResponse memory)
    {
        return OrderBook(orderBook).removeLiquidity(params);
    }

    /// @dev this is the non-view version of getLiquidityCoefficientInFundingPayment()
    /// @return liquidityCoefficientInFundingPayment the funding payment of all orders/liquidity of a maker
    function updateFundingGrowthAndLiquidityCoefficientInFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory fundingGrowthGlobal
    ) external onlyClearingHouse returns (int256 liquidityCoefficientInFundingPayment) {
        return
            OrderBook(orderBook).updateFundingGrowthAndLiquidityCoefficientInFundingPayment(
                trader,
                baseToken,
                fundingGrowthGlobal
            );
    }

    // return the price after replay swap (final tick)
    function replaySwap(ReplaySwapParams memory params) external returns (int24) {
        ExchangeRegistry.Info memory marketInfo = ExchangeRegistry(exchangeRegistry).getInfo(params.baseToken);
        uint24 exchangeFeeRatio = marketInfo.exchangeFeeRatio;
        uint24 uniswapFeeRatio = marketInfo.uniswapFeeRatio;
        (, int256 signedScaledAmountForReplaySwap) =
            _getScaledAmountForSwaps(
                params.isBaseToQuote,
                params.isExactInput,
                params.amount,
                exchangeFeeRatio,
                uniswapFeeRatio
            );
        UniswapV3Broker.SwapState memory swapState =
            UniswapV3Broker.getSwapState(
                marketInfo.pool,
                signedScaledAmountForReplaySwap,
                OrderBook(orderBook).getFeeGrowthGlobal(params.baseToken)
            );

        // globalFundingGrowth can be empty if shouldUpdateState is false
        OrderBook.ReplaySwapResponse memory response =
            OrderBook(orderBook).replaySwap(
                OrderBook.InternalReplaySwapParams({
                    state: swapState,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    exchangeFeeRatio: exchangeFeeRatio,
                    uniswapFeeRatio: uniswapFeeRatio,
                    shouldUpdateState: false,
                    globalFundingGrowth: Funding.Growth({ twPremiumX96: 0, twPremiumDivBySqrtPriceX96: 0 })
                })
            );
        return response.tick;
    }

    /// @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        // not order book
        require(_msgSender() == orderBook, "EX_NOB");
        IUniswapV3MintCallback(clearingHouse).uniswapV3MintCallback(amount0Owed, amount1Owed, data);
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override checkCallback {
        IUniswapV3SwapCallback(clearingHouse).uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    //
    // EXTERNAL VIEW
    //

    // TODO remove
    function getPool(address baseToken) external view returns (address) {
        return ExchangeRegistry(exchangeRegistry).getPool(baseToken);
    }

    // TODO remove
    function getFeeRatio(address baseToken) external view returns (uint24) {
        return ExchangeRegistry(exchangeRegistry).getFeeRatio(baseToken);
    }

    // TODO move to interface
    function getOpenOrderIds(address trader, address baseToken) external view returns (bytes32[] memory) {
        return OrderBook(orderBook).getOpenOrderIds(trader, baseToken);
    }

    // TODO move to interface
    function getOpenOrder(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view returns (OrderBook.OpenOrder memory) {
        return OrderBook(orderBook).getOpenOrder(trader, baseToken, lowerTick, upperTick);
    }

    function getTick(address baseToken) external view returns (int24) {
        return UniswapV3Broker.getTick(ExchangeRegistry(exchangeRegistry).getPool(baseToken));
    }

    // TODO move to interface
    function hasOrder(address trader, address[] calldata tokens) external view returns (bool) {
        return OrderBook(orderBook).hasOrder(trader, tokens);
    }

    // TODO move to interface
    /// @dev note the return value includes maker fee.
    ///      For more details please refer to _getTotalTokenAmountInPool() docstring
    function getTotalQuoteAmountInPools(address trader, address[] calldata baseTokens) external view returns (uint256) {
        return OrderBook(orderBook).getTotalQuoteAmountInPools(trader, baseTokens);
    }

    // TODO move to interface
    /// @dev the returned quote amount does not include funding payment because
    ///      the latter is counted directly toward realizedPnl.
    ///      please refer to _getTotalTokenAmountInPool() docstring for specs
    function getTotalTokenAmountInPool(
        address trader,
        address baseToken,
        bool fetchBase // true: fetch base amount, false: fetch quote amount
    ) external view returns (uint256 tokenAmount) {
        return OrderBook(orderBook).getTotalTokenAmountInPool(trader, baseToken, fetchBase);
    }

    function getSqrtMarkTwapX96(address baseToken, uint32 twapInterval) external view returns (uint160) {
        return UniswapV3Broker.getSqrtMarkTwapX96(ExchangeRegistry(exchangeRegistry).getPool(baseToken), twapInterval);
    }

    // TODO move to interface
    /// @dev this is the view version of updateFundingGrowthAndLiquidityCoefficientInFundingPayment()
    /// @return liquidityCoefficientInFundingPayment the funding payment of all orders/liquidity of a maker
    function getLiquidityCoefficientInFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory fundingGrowthGlobal
    ) external view returns (int256 liquidityCoefficientInFundingPayment) {
        return OrderBook(orderBook).getLiquidityCoefficientInFundingPayment(trader, baseToken, fundingGrowthGlobal);
    }

    //
    // INTERNAL
    //

    //
    // INTERNAL VIEW
    //

    /// @dev CANNOT use safeMath for feeGrowthInside calculation, as it can be extremely large and overflow
    /// @dev the difference between two feeGrowthInside, however, is correct and won't be affected by overflow or not
    function _calcOwedFee(
        uint128 liquidity,
        uint256 newFeeGrowthInside,
        uint256 oldFeeGrowthInside
    ) internal pure returns (uint256) {
        return FullMath.mulDiv(newFeeGrowthInside - oldFeeGrowthInside, liquidity, FixedPoint128.Q128);
    }

    /// @return scaledAmountForUniswapV3PoolSwap the unsigned scaled amount for UniswapV3Pool.swap()
    /// @return signedScaledAmountForReplaySwap the signed scaled amount for _replaySwap()
    /// @dev for UniswapV3Pool.swap(), scaling the amount is necessary to achieve the custom fee effect
    /// @dev for _replaySwap(), however, as we can input ExchangeFeeRatioRatio directly in SwapMath.computeSwapStep(),
    ///      there is no need to stick to the scaled amount
    /// @dev refer to CH._openPosition() docstring for explainer diagram
    function _getScaledAmountForSwaps(
        bool isBaseToQuote,
        bool isExactInput,
        uint256 amount,
        uint24 exchangeFeeRatio,
        uint24 uniswapFeeRatio
    ) internal pure returns (uint256 scaledAmountForUniswapV3PoolSwap, int256 signedScaledAmountForReplaySwap) {
        scaledAmountForUniswapV3PoolSwap = FeeMath.calcScaledAmountForUniswapV3PoolSwap(
            isBaseToQuote,
            isExactInput,
            amount,
            exchangeFeeRatio,
            uniswapFeeRatio
        );

        // x : uniswapFeeRatio, y : exchangeFeeRatioRatio
        // since we can input ExchangeFeeRatioRatio directly in SwapMath.computeSwapStep() in _replaySwap(),
        // when !isBaseToQuote, we can use the original amount directly
        // ex: when x(uniswapFeeRatio) = 1%, y(exchangeFeeRatioRatio) = 3%, input == 1 quote
        // our target is to get fee == 0.03 quote
        // if scaling the input as 1 * 0.97 / 0.99, the fee calculated in `_replaySwap()` won't be 0.03
        signedScaledAmountForReplaySwap = isBaseToQuote
            ? scaledAmountForUniswapV3PoolSwap.toInt256()
            : amount.toInt256();
        signedScaledAmountForReplaySwap = isExactInput
            ? signedScaledAmountForReplaySwap
            : -signedScaledAmountForReplaySwap;
    }
}
