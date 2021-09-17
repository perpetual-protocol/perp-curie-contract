// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
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
import { AccountMarket } from "./lib/AccountMarket.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { ClearingHouseCallee } from "./base/ClearingHouseCallee.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { VirtualToken } from "./VirtualToken.sol";
import { MarketRegistry } from "./MarketRegistry.sol";
import { OrderBook } from "./OrderBook.sol";

contract Exchange is IUniswapV3MintCallback, IUniswapV3SwapCallback, ClearingHouseCallee, ArbBlockContext {
    using AddressUpgradeable for address;
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

    address public orderBook;

    function initialize(address marketRegistryArg, address orderBookArg) external initializer {
        __ClearingHouseCallee_init(marketRegistryArg);

        // OrderBook is not contract
        require(orderBookArg.isContract(), "EX_OBNC");

        // update states
        orderBook = orderBookArg;
    }

    //
    // MODIFIERS
    //

    //
    // EXTERNAL FUNCTIONS
    //
    function swap(SwapParams memory params) external onlyClearingHouse returns (SwapResponse memory) {
        MarketRegistry.MarketInfo memory marketInfo = MarketRegistry(marketRegistry).getMarketInfo(params.baseToken);

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
                OrderBook.ReplaySwapParams({
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    shouldUpdateState: true,
                    amount: signedScaledAmountForReplaySwap,
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

        if (getFirstTradedTimestamp(params.baseToken) == 0) {
            updateFirstTradedTimestamp(params.baseToken);
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

    // return the price after replay swap (final tick)
    function replaySwap(ReplaySwapParams memory params) external returns (int24) {
        MarketRegistry.MarketInfo memory marketInfo = MarketRegistry(marketRegistry).getMarketInfo(params.baseToken);
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

        // globalFundingGrowth can be empty if shouldUpdateState is false
        OrderBook.ReplaySwapResponse memory response =
            OrderBook(orderBook).replaySwap(
                OrderBook.ReplaySwapParams({
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    amount: signedScaledAmountForReplaySwap,
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

    // FUNDING THINGS
    event FundingPaymentSettled(
        address indexed trader,
        address indexed baseToken,
        int256 amount // +: trader pays, -: trader receives
    );
    event FundingUpdated(address indexed baseToken, uint256 markTwap, uint256 indexTwap);

    mapping(address => uint256) internal _lastSettledTimestampMap;
    mapping(address => Funding.Growth) internal _globalFundingGrowthX96Map;
    mapping(address => uint256) internal _firstTradedTimestampMap;
    mapping(address => int24) internal _lastUpdatedTickMap;

    function settleFundingAndUpdateFundingGrowth(
        address trader,
        address baseToken,
        int256 baseBalance,
        int256 twPremiumGrowthGlobalX96
    ) external returns (Funding.Growth memory fundingGrowthGlobal, int256 fundingPayment) {
        uint256 markTwap;
        uint256 indexTwap;
        (fundingGrowthGlobal, markTwap, indexTwap) = getFundingGrowthGlobalAndTwaps(baseToken);

        fundingPayment = _updateFundingGrowthAndFundingPayment(
            trader,
            baseToken,
            baseBalance,
            twPremiumGrowthGlobalX96,
            fundingGrowthGlobal
        );

        if (fundingPayment != 0) {
            emit FundingPaymentSettled(trader, baseToken, fundingPayment);
        }

        // update states before further actions in this block; once per block
        if (_blockTimestamp() != _lastSettledTimestampMap[baseToken]) {
            // update fundingGrowthGlobal
            Funding.Growth storage lastFundingGrowthGlobal = _globalFundingGrowthX96Map[baseToken];
            (
                _lastSettledTimestampMap[baseToken],
                lastFundingGrowthGlobal.twPremiumX96,
                lastFundingGrowthGlobal.twPremiumDivBySqrtPriceX96
            ) = (_blockTimestamp(), fundingGrowthGlobal.twPremiumX96, fundingGrowthGlobal.twPremiumDivBySqrtPriceX96);

            // update tick
            _lastUpdatedTickMap[baseToken] = getTick(baseToken);

            emit FundingUpdated(baseToken, markTwap, indexTwap);
        }

        return (fundingGrowthGlobal, fundingPayment);
    }

    function getFundingGrowthGlobalAndTwaps(address baseToken)
        public
        view
        returns (
            Funding.Growth memory fundingGrowthGlobal,
            uint256 markTwap,
            uint256 indexTwap
        )
    {
        Funding.Growth storage lastFundingGrowthGlobal = _globalFundingGrowthX96Map[baseToken];

        // get mark twap
        uint32 twapIntervalArg = _getTwapInterval();
        // shorten twapInterval if prior observations are not enough for twapInterval
        if (_firstTradedTimestampMap[baseToken] == 0) {
            twapIntervalArg = 0;
        } else if (twapIntervalArg > _blockTimestamp().sub(_firstTradedTimestampMap[baseToken])) {
            // overflow inspection:
            // 2 ^ 32 = 4,294,967,296 > 100 years = 60 * 60 * 24 * 365 * 100 = 3,153,600,000
            twapIntervalArg = uint32(_blockTimestamp().sub(_firstTradedTimestampMap[baseToken]));
        }

        uint256 markTwapX96 = getSqrtMarkTwapX96(baseToken, twapIntervalArg).formatSqrtPriceX96ToPriceX96();
        markTwap = markTwapX96.formatX96ToX10_18();
        indexTwap = _getIndexPrice(baseToken);

        uint256 lastSettledTimestamp = _lastSettledTimestampMap[baseToken];
        if (_blockTimestamp() != lastSettledTimestamp && lastSettledTimestamp != 0) {
            int256 twPremiumDeltaX96 =
                markTwapX96.toInt256().sub(indexTwap.formatX10_18ToX96().toInt256()).mul(
                    _blockTimestamp().sub(lastSettledTimestamp).toInt256()
                );
            fundingGrowthGlobal.twPremiumX96 = lastFundingGrowthGlobal.twPremiumX96.add(twPremiumDeltaX96);

            // overflow inspection:
            // assuming premium = 1 billion (1e9), time diff = 1 year (3600 * 24 * 365)
            // log(1e9 * 2^96 * (3600 * 24 * 365) * 2^96) / log(2) = 246.8078491997 < 255
            fundingGrowthGlobal.twPremiumDivBySqrtPriceX96 = lastFundingGrowthGlobal.twPremiumDivBySqrtPriceX96.add(
                (twPremiumDeltaX96.mul(PerpFixedPoint96.IQ96)).div(uint256(getSqrtMarkTwapX96(baseToken, 0)).toInt256())
            );
        } else {
            // if this is the latest updated block, values in _globalFundingGrowthX96Map are up-to-date already
            fundingGrowthGlobal = lastFundingGrowthGlobal;
        }

        return (fundingGrowthGlobal, markTwap, indexTwap);
    }

    function _updateFundingGrowthAndFundingPayment(
        address trader,
        address baseToken,
        int256 baseBalance,
        int256 twPremiumGrowthGlobalX96,
        Funding.Growth memory fundingGrowthGlobal
    ) public returns (int256 fundingPayment) {
        int256 liquidityCoefficientInFundingPayment =
            OrderBook(orderBook).updateFundingGrowthAndLiquidityCoefficientInFundingPayment(
                trader,
                baseToken,
                fundingGrowthGlobal
            );

        int256 balanceCoefficientInFundingPayment =
            AccountMarket.getBalanceCoefficientInFundingPayment(
                baseBalance,
                fundingGrowthGlobal.twPremiumX96,
                twPremiumGrowthGlobalX96
            );

        return liquidityCoefficientInFundingPayment.add(balanceCoefficientInFundingPayment).div(1 days);
    }

    function getPendingFundingPayment(
        address trader,
        address baseToken,
        int256 baseBalance,
        int256 twPremiumGrowthGlobalX96
    ) public view returns (int256) {
        (Funding.Growth memory fundingGrowthGlobal, , ) = getFundingGrowthGlobalAndTwaps(baseToken);
        return _getPendingFundingPayment(trader, baseToken, baseBalance, twPremiumGrowthGlobalX96, fundingGrowthGlobal);
    }

    function _getPendingFundingPayment(
        address trader,
        address baseToken,
        int256 baseBalance,
        int256 twPremiumGrowthGlobalX96,
        Funding.Growth memory fundingGrowthGlobal
    ) internal view returns (int256 fundingPayment) {
        int256 liquidityCoefficientInFundingPayment =
            OrderBook(orderBook).getLiquidityCoefficientInFundingPayment(trader, baseToken, fundingGrowthGlobal);

        int256 balanceCoefficientInFundingPayment =
            AccountMarket.getBalanceCoefficientInFundingPayment(
                baseBalance,
                fundingGrowthGlobal.twPremiumX96,
                twPremiumGrowthGlobalX96
            );

        return liquidityCoefficientInFundingPayment.add(balanceCoefficientInFundingPayment).div(1 days);
    }

    function _getTwapInterval() internal view returns (uint32) {
        return 900;
    }

    function _getIndexPrice(address baseToken) internal view returns (uint256) {
        return IIndexPrice(baseToken).getIndexPrice(_getTwapInterval());
    }

    function updateFirstTradedTimestamp(address baseToken) public onlyClearingHouse {
        _firstTradedTimestampMap[baseToken] = _blockTimestamp();
    }

    function getFirstTradedTimestamp(address baseToken) public view returns (uint256) {
        return _firstTradedTimestampMap[baseToken];
    }

    function getLastUpdatedTickMap(address baseToken) external view returns (int24) {
        return _lastUpdatedTickMap[baseToken];
    }

    //
    // EXTERNAL VIEW
    //

    // TODO should be able to remove if we can remove CH._hasPool
    function getPool(address baseToken) external view returns (address) {
        return MarketRegistry(marketRegistry).getPool(baseToken);
    }

    function getTick(address baseToken) public view returns (int24) {
        return UniswapV3Broker.getTick(MarketRegistry(marketRegistry).getPool(baseToken));
    }

    function getSqrtMarkTwapX96(address baseToken, uint32 twapInterval) public view returns (uint160) {
        return UniswapV3Broker.getSqrtMarkTwapX96(MarketRegistry(marketRegistry).getPool(baseToken), twapInterval);
    }

    //
    // INTERNAL
    //

    //
    // INTERNAL VIEW
    //

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
