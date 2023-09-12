// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { BlockContext } from "./base/BlockContext.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { SwapMath } from "./lib/SwapMath.sol";
import { PerpFixedPoint96 } from "./lib/PerpFixedPoint96.sol";
import { Funding } from "./lib/Funding.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { AccountMarket } from "./lib/AccountMarket.sol";
import { ClearingHouseCallee } from "./base/ClearingHouseCallee.sol";
import { UniswapV3CallbackBridge } from "./base/UniswapV3CallbackBridge.sol";
import { IOrderBook } from "./interface/IOrderBook.sol";
import { IMarketRegistry } from "./interface/IMarketRegistry.sol";
import { IAccountBalance } from "./interface/IAccountBalance.sol";
import { IClearingHouseConfig } from "./interface/IClearingHouseConfig.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { IBaseToken } from "./interface/IBaseToken.sol";
import { ExchangeStorageV2 } from "./storage/ExchangeStorage.sol";
import { IExchange } from "./interface/IExchange.sol";
import { OpenOrder } from "./lib/OpenOrder.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract Exchange is
    IUniswapV3SwapCallback,
    IExchange,
    BlockContext,
    ClearingHouseCallee,
    UniswapV3CallbackBridge,
    ExchangeStorageV2
{
    using AddressUpgradeable for address;
    using SafeMathUpgradeable for uint256;
    using SignedSafeMathUpgradeable for int256;
    using SignedSafeMathUpgradeable for int24;
    using PerpMath for uint256;
    using PerpMath for uint160;
    using PerpMath for int256;
    using PerpSafeCast for uint24;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;

    //
    // STRUCT
    //
    struct InternalSwapResponse {
        int256 base;
        int256 quote;
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        uint256 fee;
        uint256 insuranceFundFee;
        int24 tick;
    }

    struct InternalRealizePnlParams {
        address trader;
        address baseToken;
        int256 takerPositionSize;
        int256 takerOpenNotional;
        int256 base;
        int256 quote;
    }

    //
    // CONSTANT
    //
    uint256 internal constant _FULLY_CLOSED_RATIO = 1e18;
    uint24 internal constant _MAX_TICK_CROSSED_WITHIN_BLOCK_CAP = 1000; // 10%
    uint24 internal constant _MAX_PRICE_SPREAD_RATIO = 0.1e6; // 10% in decimal 6
    uint256 internal constant _PRICE_LIMIT_INTERVAL = 15; // 15 sec

    //
    // EXTERNAL NON-VIEW
    //
    function initialize(
        address marketRegistryArg,
        address orderBookArg,
        address clearingHouseConfigArg
    ) external initializer {
        __ClearingHouseCallee_init();
        __UniswapV3CallbackBridge_init(marketRegistryArg);

        // E_OBNC: OrderBook is not contract
        require(orderBookArg.isContract(), "E_OBNC");
        // E_CHNC: CH is not contract
        require(clearingHouseConfigArg.isContract(), "E_CHNC");

        // update states
        _orderBook = orderBookArg;
        _clearingHouseConfig = clearingHouseConfigArg;
    }

    /// @param accountBalanceArg: AccountBalance contract address
    function setAccountBalance(address accountBalanceArg) external onlyOwner {
        // accountBalance is 0
        require(accountBalanceArg != address(0), "E_AB0");
        _accountBalance = accountBalanceArg;
        emit AccountBalanceChanged(accountBalanceArg);
    }

    /// @dev Restrict the price impact by setting the ticks can be crossed within a block when
    /// trader reducing liquidity. It is used to prevent the malicious behavior of the malicious traders.
    /// The restriction is applied in _isOverPriceLimitWithTick()
    /// @param baseToken The base token address
    /// @param maxTickCrossedWithinBlock The maximum ticks can be crossed within a block
    function setMaxTickCrossedWithinBlock(address baseToken, uint24 maxTickCrossedWithinBlock) external onlyOwner {
        // EX_BNC: baseToken is not contract
        require(baseToken.isContract(), "EX_BNC");
        // EX_BTNE: base token does not exists
        require(IMarketRegistry(_marketRegistry).hasPool(baseToken), "EX_BTNE");

        // tick range is [MIN_TICK, MAX_TICK], maxTickCrossedWithinBlock should be in [0, MAX_TICK - MIN_TICK]
        // EX_MTCLOOR: max tick crossed limit out of range
        require(maxTickCrossedWithinBlock <= _getMaxTickCrossedWithinBlockCap(), "EX_MTCLOOR");

        _maxTickCrossedWithinBlockMap[baseToken] = maxTickCrossedWithinBlock;
        emit MaxTickCrossedWithinBlockChanged(baseToken, maxTickCrossedWithinBlock);
    }

    /// @inheritdoc IUniswapV3SwapCallback
    /// @dev This callback is forwarded to ClearingHouse.uniswapV3SwapCallback() because all the tokens
    /// are stored in there.
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override checkCallback {
        IUniswapV3SwapCallback(_clearingHouse).uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @param params The parameters of the swap
    /// @return The result of the swap
    /// @dev can only be called from ClearingHouse
    /// @inheritdoc IExchange
    function swap(SwapParams memory params) external override returns (SwapResponse memory) {
        _requireOnlyClearingHouse();

        // EX_MIP: market is paused
        require(_maxTickCrossedWithinBlockMap[params.baseToken] > 0, "EX_MIP");

        // get account info before swap
        int256 takerPositionSize =
            IAccountBalance(_accountBalance).getTakerPositionSize(params.trader, params.baseToken);

        int256 takerOpenNotional =
            IAccountBalance(_accountBalance).getTakerOpenNotional(params.trader, params.baseToken);

        bool isBaseToQuote = takerPositionSize < 0;

        if (params.isClose && takerPositionSize != 0) {
            // open reverse position when closing position
            params.sqrtPriceLimitX96 = _getSqrtPriceLimitForClosingPosition(
                params.baseToken,
                isBaseToQuote,
                params.sqrtPriceLimitX96
            );
        }

        InternalSwapResponse memory response = _swap(params);

        // EX_OPLAS: over price limit after swap
        require(!_isOverPriceLimitWithTick(params.baseToken, response.tick), "EX_OPLAS");

        // when takerPositionSize < 0, it's a short position
        bool isReducingPosition = takerPositionSize == 0 ? false : isBaseToQuote != params.isBaseToQuote;
        // when reducing/not increasing the position size, it's necessary to realize pnl
        int256 pnlToBeRealized;
        if (isReducingPosition) {
            pnlToBeRealized = _getPnlToBeRealized(
                InternalRealizePnlParams({
                    trader: params.trader,
                    baseToken: params.baseToken,
                    takerPositionSize: takerPositionSize,
                    takerOpenNotional: takerOpenNotional,
                    base: response.base,
                    quote: response.quote
                })
            );
        }

        (uint256 sqrtPriceX96, , , , , , ) =
            UniswapV3Broker.getSlot0(IMarketRegistry(_marketRegistry).getPool(params.baseToken));

        uint256 baseAbs = response.base.abs();

        return
            SwapResponse({
                base: baseAbs,
                quote: response.quote.abs(),
                exchangedPositionSize: response.exchangedPositionSize,
                exchangedPositionNotional: response.exchangedPositionNotional,
                fee: response.fee,
                insuranceFundFee: response.insuranceFundFee,
                pnlToBeRealized: pnlToBeRealized,
                sqrtPriceAfterX96: sqrtPriceX96,
                tick: response.tick,
                isPartialClose: params.isClose ? baseAbs < params.amount : false,
                closedRatio: params.isClose ? FullMath.mulDiv(baseAbs, 1e6, params.amount).toUint24() : 0
            });
    }

    /// @inheritdoc IExchange
    function settleFunding(address trader, address baseToken)
        external
        override
        returns (int256 fundingPayment, Funding.Growth memory fundingGrowthGlobal)
    {
        _requireOnlyClearingHouse();
        // EX_BTNE: base token does not exists
        require(IMarketRegistry(_marketRegistry).hasPool(baseToken), "EX_BTNE");

        // The purpose of caching index twap here is to save the gas consumption of calculating mark price,
        // if updating TWAP fails, this call will be reverted and thus using try-catch.
        // NOTE: the cached index twap is used for AccountBalance.MarkPrice calculation,
        // not for funding rate calculation.
        (, uint32 premiumInterval) = IClearingHouseConfig(_clearingHouseConfig).getMarkPriceConfig();
        try IBaseToken(baseToken).cacheTwap(premiumInterval) {} catch {}

        uint256 marketTwap;
        uint256 indexTwap;
        (fundingGrowthGlobal, marketTwap, indexTwap) = _getFundingGrowthGlobalAndTwaps(baseToken);

        fundingPayment = _updateFundingGrowth(
            trader,
            baseToken,
            IAccountBalance(_accountBalance).getBase(trader, baseToken),
            IAccountBalance(_accountBalance).getAccountInfo(trader, baseToken).lastTwPremiumGrowthGlobalX96,
            fundingGrowthGlobal
        );

        // funding will be stopped once the market is being paused
        uint256 timestamp =
            IBaseToken(baseToken).isOpen() ? _blockTimestamp() : IBaseToken(baseToken).getPausedTimestamp();

        // update states before further actions in this block; once per block
        if (timestamp != _lastSettledTimestampMap[baseToken]) {
            // update fundingGrowthGlobal and _lastSettledTimestamp
            Funding.Growth storage lastFundingGrowthGlobal = _globalFundingGrowthX96Map[baseToken];
            (
                _lastSettledTimestampMap[baseToken],
                lastFundingGrowthGlobal.twPremiumX96,
                lastFundingGrowthGlobal.twPremiumDivBySqrtPriceX96
            ) = (timestamp, fundingGrowthGlobal.twPremiumX96, fundingGrowthGlobal.twPremiumDivBySqrtPriceX96);

            emit FundingUpdated(baseToken, marketTwap, indexTwap);
        }

        // update tick & timestamp for price limit check
        // if timestamp diff < _PRICE_LIMIT_INTERVAL, including when the market is paused, they won't get updated
        uint256 lastTickUpdatedTimestamp = _lastTickUpdatedTimestampMap[baseToken];
        if (timestamp >= lastTickUpdatedTimestamp.add(_PRICE_LIMIT_INTERVAL)) {
            _lastTickUpdatedTimestampMap[baseToken] = timestamp;
            _lastUpdatedTickMap[baseToken] = _getTick(baseToken);
        }

        return (fundingPayment, fundingGrowthGlobal);
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc IExchange
    function getOrderBook() external view override returns (address) {
        return _orderBook;
    }

    /// @inheritdoc IExchange
    function getAccountBalance() external view override returns (address) {
        return _accountBalance;
    }

    /// @inheritdoc IExchange
    function getClearingHouseConfig() external view override returns (address) {
        return _clearingHouseConfig;
    }

    /// @inheritdoc IExchange
    function getMaxTickCrossedWithinBlock(address baseToken) external view override returns (uint24) {
        return _maxTickCrossedWithinBlockMap[baseToken];
    }

    /// @inheritdoc IExchange
    function getPnlToBeRealized(RealizePnlParams memory params) external view override returns (int256) {
        AccountMarket.Info memory info =
            IAccountBalance(_accountBalance).getAccountInfo(params.trader, params.baseToken);

        int256 takerOpenNotional = info.takerOpenNotional;
        int256 takerPositionSize = info.takerPositionSize;
        // when takerPositionSize < 0, it's a short position; when base < 0, isBaseToQuote(shorting)
        bool isReducingPosition = takerPositionSize == 0 ? false : takerPositionSize < 0 != params.base < 0;

        return
            isReducingPosition
                ? _getPnlToBeRealized(
                    InternalRealizePnlParams({
                        trader: params.trader,
                        baseToken: params.baseToken,
                        takerPositionSize: takerPositionSize,
                        takerOpenNotional: takerOpenNotional,
                        base: params.base,
                        quote: params.quote
                    })
                )
                : 0;
    }

    /// @inheritdoc IExchange
    function getAllPendingFundingPayment(address trader) external view override returns (int256 pendingFundingPayment) {
        address[] memory baseTokens = IAccountBalance(_accountBalance).getBaseTokens(trader);
        uint256 baseTokenLength = baseTokens.length;

        for (uint256 i = 0; i < baseTokenLength; i++) {
            pendingFundingPayment = pendingFundingPayment.add(getPendingFundingPayment(trader, baseTokens[i]));
        }
        return pendingFundingPayment;
    }

    /// @inheritdoc IExchange
    function isOverPriceSpread(address baseToken) external view override returns (bool) {
        return
            _getPriceSpreadRatio(baseToken, IClearingHouseConfig(_clearingHouseConfig).getTwapInterval()).abs() >
            _MAX_PRICE_SPREAD_RATIO;
    }

    /// @inheritdoc IExchange
    // **Deprecated function, will be removed in the next release, use `getSqrtMarketTwapX96()` instead**
    function getSqrtMarkTwapX96(address baseToken, uint32 twapInterval) external view override returns (uint160) {
        return _getSqrtMarketTwapX96(baseToken, twapInterval);
    }

    /// @inheritdoc IExchange
    function getSqrtMarketTwapX96(address baseToken, uint32 twapInterval) external view override returns (uint160) {
        return _getSqrtMarketTwapX96(baseToken, twapInterval);
    }

    //
    // PUBLIC VIEW
    //

    /// @inheritdoc IExchange
    function getPendingFundingPayment(address trader, address baseToken) public view override returns (int256) {
        (Funding.Growth memory fundingGrowthGlobal, , ) = _getFundingGrowthGlobalAndTwaps(baseToken);

        int256 liquidityCoefficientInFundingPayment =
            IOrderBook(_orderBook).getLiquidityCoefficientInFundingPayment(trader, baseToken, fundingGrowthGlobal);

        return
            Funding.calcPendingFundingPaymentWithLiquidityCoefficient(
                IAccountBalance(_accountBalance).getBase(trader, baseToken),
                IAccountBalance(_accountBalance).getAccountInfo(trader, baseToken).lastTwPremiumGrowthGlobalX96,
                fundingGrowthGlobal,
                liquidityCoefficientInFundingPayment
            );
    }

    //
    // INTERNAL NON-VIEW
    //

    /// @dev customized fee: https://www.notion.so/perp/Customise-fee-tier-on-B2QFee-1b7244e1db63416c8651e8fa04128cdb
    function _swap(SwapParams memory params) internal returns (InternalSwapResponse memory) {
        IMarketRegistry.MarketInfo memory marketInfo =
            IMarketRegistry(_marketRegistry).getMarketInfoByTrader(params.trader, params.baseToken);

        (uint256 scaledAmountForUniswapV3PoolSwap, int256 signedScaledAmountForReplaySwap) =
            SwapMath.calcScaledAmountForSwaps(
                params.isBaseToQuote,
                params.isExactInput,
                params.amount,
                marketInfo.exchangeFeeRatio,
                marketInfo.uniswapFeeRatio
            );

        (Funding.Growth memory fundingGrowthGlobal, , ) = _getFundingGrowthGlobalAndTwaps(params.baseToken);
        // simulate the swap to calculate the fees charged in exchange
        IOrderBook.ReplaySwapResponse memory replayResponse =
            IOrderBook(_orderBook).replaySwap(
                IOrderBook.ReplaySwapParams({
                    baseToken: params.baseToken,
                    pool: marketInfo.pool,
                    isBaseToQuote: params.isBaseToQuote,
                    shouldUpdateState: true,
                    amount: signedScaledAmountForReplaySwap,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    exchangeFeeRatio: marketInfo.exchangeFeeRatio,
                    uniswapFeeRatio: marketInfo.uniswapFeeRatio,
                    insuranceFundFeeRatio: marketInfo.insuranceFundFeeRatio,
                    globalFundingGrowth: fundingGrowthGlobal
                })
            );

        int256 priceSpreadRatioBeforeSwap = _getPriceSpreadRatio(params.baseToken, 0);

        UniswapV3Broker.SwapResponse memory response =
            UniswapV3Broker.swap(
                UniswapV3Broker.SwapParams(
                    marketInfo.pool,
                    _clearingHouse,
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

        int24 tick = UniswapV3Broker.getTick(marketInfo.pool);
        // tick mismatch
        require(tick == replayResponse.tick, "EX_TKMM");

        // avoid stack too deep
        {
            // check price band after swap
            int256 priceSpreadRatioAfterSwap = _getPriceSpreadRatio(params.baseToken, 0);
            int256 maxPriceSpreadRatio = marketInfo.maxPriceSpreadRatio.toInt256();
            require(
                PerpMath.min(priceSpreadRatioBeforeSwap, maxPriceSpreadRatio.neg256()) <= priceSpreadRatioAfterSwap &&
                    priceSpreadRatioAfterSwap <= PerpMath.max(priceSpreadRatioBeforeSwap, maxPriceSpreadRatio),
                "EX_OPB"
            );
        }

        // as we charge fees in ClearingHouse instead of in Uniswap pools,
        // we need to scale up base or quote amounts to get the exact exchanged position size and notional
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        if (params.isBaseToQuote) {
            // short: exchangedPositionSize <= 0 && exchangedPositionNotional >= 0
            exchangedPositionSize = SwapMath
                .calcAmountScaledByFeeRatio(response.base, marketInfo.uniswapFeeRatio, false)
                .neg256();
            // due to base to quote fee, exchangedPositionNotional contains the fee
            // s.t. we can take the fee away from exchangedPositionNotional
            exchangedPositionNotional = response.quote.toInt256();
        } else {
            // long: exchangedPositionSize >= 0 && exchangedPositionNotional <= 0
            exchangedPositionSize = response.base.toInt256();

            // scaledAmountForUniswapV3PoolSwap is the amount of quote token to swap (input),
            // response.quote is the actual amount of quote token swapped (output).
            // as long as liquidity is enough, they would be equal.
            // otherwise, response.quote < scaledAmountForUniswapV3PoolSwap
            // which also means response.quote < exact input amount.
            if (params.isExactInput && response.quote == scaledAmountForUniswapV3PoolSwap) {
                // NOTE: replayResponse.fee might have an extra charge of 1 wei, for instance:
                // Q2B exact input amount 1000000000000000000000 with fee ratio 1%,
                // replayResponse.fee is actually 10000000000000000001 (1000 * 1% + 1 wei),
                // and quote = exchangedPositionNotional - replayResponse.fee = -1000000000000000000001
                // which is not matched with exact input 1000000000000000000000
                // we modify exchangedPositionNotional here to make sure
                // quote = exchangedPositionNotional - replayResponse.fee = exact input
                exchangedPositionNotional = params.amount.sub(replayResponse.fee).toInt256().neg256();
            } else {
                exchangedPositionNotional = SwapMath
                    .calcAmountScaledByFeeRatio(response.quote, marketInfo.uniswapFeeRatio, false)
                    .neg256();
            }
        }

        // update the timestamp of the first tx in this market
        if (_firstTradedTimestampMap[params.baseToken] == 0) {
            _firstTradedTimestampMap[params.baseToken] = _blockTimestamp();
        }

        return
            InternalSwapResponse({
                base: exchangedPositionSize,
                quote: exchangedPositionNotional.sub(replayResponse.fee.toInt256()),
                exchangedPositionSize: exchangedPositionSize,
                exchangedPositionNotional: exchangedPositionNotional,
                fee: replayResponse.fee,
                insuranceFundFee: replayResponse.insuranceFundFee,
                tick: replayResponse.tick
            });
    }

    /// @dev this is the non-view version of getPendingFundingPayment()
    /// @return pendingFundingPayment the pending funding payment of a trader in one market,
    ///         including liquidity & balance coefficients
    function _updateFundingGrowth(
        address trader,
        address baseToken,
        int256 baseBalance,
        int256 twPremiumGrowthGlobalX96,
        Funding.Growth memory fundingGrowthGlobal
    ) internal returns (int256 pendingFundingPayment) {
        int256 liquidityCoefficientInFundingPayment =
            IOrderBook(_orderBook).updateFundingGrowthAndLiquidityCoefficientInFundingPayment(
                trader,
                baseToken,
                fundingGrowthGlobal
            );

        return
            Funding.calcPendingFundingPaymentWithLiquidityCoefficient(
                baseBalance,
                twPremiumGrowthGlobalX96,
                fundingGrowthGlobal,
                liquidityCoefficientInFundingPayment
            );
    }

    //
    // INTERNAL VIEW
    //
    function _getSqrtMarketTwapX96(address baseToken, uint32 twapInterval) internal view returns (uint160) {
        return UniswapV3Broker.getSqrtMarketTwapX96(IMarketRegistry(_marketRegistry).getPool(baseToken), twapInterval);
    }

    function _isOverPriceLimitWithTick(address baseToken, int24 tick) internal view returns (bool) {
        uint24 maxDeltaTick = _maxTickCrossedWithinBlockMap[baseToken];
        int24 lastUpdatedTick = _lastUpdatedTickMap[baseToken];
        // no overflow/underflow issue because there are range limits for tick and maxDeltaTick
        int24 upperTickBound = lastUpdatedTick.add(maxDeltaTick).toInt24();
        int24 lowerTickBound = lastUpdatedTick.sub(maxDeltaTick).toInt24();
        return (tick < lowerTickBound || tick > upperTickBound);
    }

    function _getTick(address baseToken) internal view returns (int24) {
        (, int24 tick, , , , , ) = UniswapV3Broker.getSlot0(IMarketRegistry(_marketRegistry).getPool(baseToken));
        return tick;
    }

    /// @dev this function calculates the up-to-date globalFundingGrowth and twaps and pass them out
    /// @return fundingGrowthGlobal the up-to-date globalFundingGrowth
    /// @return marketTwap only for settleFunding()
    /// @return indexTwap only for settleFunding()
    function _getFundingGrowthGlobalAndTwaps(address baseToken)
        internal
        view
        returns (
            Funding.Growth memory fundingGrowthGlobal,
            uint256 marketTwap,
            uint256 indexTwap
        )
    {
        bool marketOpen = IBaseToken(baseToken).isOpen();
        uint256 timestamp = marketOpen ? _blockTimestamp() : IBaseToken(baseToken).getPausedTimestamp();

        // shorten twapInterval if prior observations are not enough
        uint32 twapInterval;
        if (_firstTradedTimestampMap[baseToken] != 0) {
            twapInterval = IClearingHouseConfig(_clearingHouseConfig).getTwapInterval();
            // overflow inspection:
            // 2 ^ 32 = 4,294,967,296 > 100 years = 60 * 60 * 24 * 365 * 100 = 3,153,600,000
            uint32 deltaTimestamp = timestamp.sub(_firstTradedTimestampMap[baseToken]).toUint32();
            twapInterval = twapInterval > deltaTimestamp ? deltaTimestamp : twapInterval;
        }

        uint256 marketTwapX96;
        if (marketOpen) {
            marketTwapX96 = _getSqrtMarketTwapX96(baseToken, twapInterval).formatSqrtPriceX96ToPriceX96();
            indexTwap = IIndexPrice(baseToken).getIndexPrice(twapInterval);
        } else {
            // if a market is paused/closed, we use the last known index price which is getPausedIndexPrice
            //
            // -----+--- twap interval ---+--- secondsAgo ---+
            //                        pausedTime            now

            // timestamp is pausedTime when the market is not open
            uint32 secondsAgo = _blockTimestamp().sub(timestamp).toUint32();
            marketTwapX96 = UniswapV3Broker
                .getSqrtMarketTwapX96From(IMarketRegistry(_marketRegistry).getPool(baseToken), secondsAgo, twapInterval)
                .formatSqrtPriceX96ToPriceX96();
            indexTwap = IBaseToken(baseToken).getPausedIndexPrice();
        }
        marketTwap = marketTwapX96.formatX96ToX10_18();

        uint256 lastSettledTimestamp = _lastSettledTimestampMap[baseToken];
        Funding.Growth storage lastFundingGrowthGlobal = _globalFundingGrowthX96Map[baseToken];
        if (timestamp == lastSettledTimestamp || lastSettledTimestamp == 0) {
            // if this is the latest updated timestamp, values in _globalFundingGrowthX96Map are up-to-date already
            fundingGrowthGlobal = lastFundingGrowthGlobal;
        } else {
            // deltaTwPremium = (marketTwap - indexTwap) * (now - lastSettledTimestamp)
            int256 deltaTwPremiumX96 =
                _getDeltaTwapX96(marketTwapX96, indexTwap.formatX10_18ToX96()).mul(
                    timestamp.sub(lastSettledTimestamp).toInt256()
                );
            fundingGrowthGlobal.twPremiumX96 = lastFundingGrowthGlobal.twPremiumX96.add(deltaTwPremiumX96);

            // overflow inspection:
            // assuming premium = 1 billion (1e9), time diff = 1 year (3600 * 24 * 365)
            // log(1e9 * 2^96 * (3600 * 24 * 365) * 2^96) / log(2) = 246.8078491997 < 255
            // twPremiumDivBySqrtPrice += deltaTwPremium / getSqrtMarketTwap(baseToken)
            fundingGrowthGlobal.twPremiumDivBySqrtPriceX96 = lastFundingGrowthGlobal.twPremiumDivBySqrtPriceX96.add(
                PerpMath.mulDiv(deltaTwPremiumX96, PerpFixedPoint96._IQ96, _getSqrtMarketTwapX96(baseToken, 0))
            );
        }

        return (fundingGrowthGlobal, marketTwap, indexTwap);
    }

    /// @dev get a sqrt price limit for closing position s.t. it can stop when reaching the limit to save gas
    function _getSqrtPriceLimitForClosingPosition(
        address baseToken,
        bool isBaseToQuote,
        uint160 inputSqrtPriceLimitX96
    ) internal view returns (uint160) {
        int24 lastUpdatedTick = _lastUpdatedTickMap[baseToken];
        uint24 maxDeltaTick = _maxTickCrossedWithinBlockMap[baseToken];

        // price limit = upper tick boundary or lower tick boundary depending on which direction
        int24 tickBoundary =
            isBaseToQuote ? lastUpdatedTick + int24(maxDeltaTick) : lastUpdatedTick - int24(maxDeltaTick);

        // tickBoundary should be in (MIN_TICK, MAX_TICK)
        // ref: https://github.com/Uniswap/v3-core/blob/main/contracts/UniswapV3Pool.sol#L608
        tickBoundary = tickBoundary > TickMath.MAX_TICK ? TickMath.MAX_TICK - 1 : tickBoundary;
        tickBoundary = tickBoundary < TickMath.MIN_TICK ? TickMath.MIN_TICK + 1 : tickBoundary;

        uint160 targetSqrtPriceLimitX96 = TickMath.getSqrtRatioAtTick(tickBoundary);

        if (inputSqrtPriceLimitX96 == 0) {
            return targetSqrtPriceLimitX96;
        }

        if (isBaseToQuote) {
            return targetSqrtPriceLimitX96 > inputSqrtPriceLimitX96 ? inputSqrtPriceLimitX96 : targetSqrtPriceLimitX96;
        }

        return targetSqrtPriceLimitX96 < inputSqrtPriceLimitX96 ? inputSqrtPriceLimitX96 : targetSqrtPriceLimitX96;
    }

    function _getDeltaTwapX96(uint256 marketTwapX96, uint256 indexTwapX96) internal view returns (int256 deltaTwapX96) {
        uint24 maxFundingRate = IClearingHouseConfig(_clearingHouseConfig).getMaxFundingRate();
        uint256 maxDeltaTwapX96 = indexTwapX96.mulRatio(maxFundingRate);
        uint256 absDeltaTwapX96;
        if (marketTwapX96 > indexTwapX96) {
            absDeltaTwapX96 = marketTwapX96.sub(indexTwapX96);
            deltaTwapX96 = absDeltaTwapX96 > maxDeltaTwapX96 ? maxDeltaTwapX96.toInt256() : absDeltaTwapX96.toInt256();
        } else {
            absDeltaTwapX96 = indexTwapX96.sub(marketTwapX96);
            deltaTwapX96 = absDeltaTwapX96 > maxDeltaTwapX96 ? maxDeltaTwapX96.neg256() : absDeltaTwapX96.neg256();
        }
    }

    /// @dev ratio will return in int256
    function _getPriceSpreadRatio(address baseToken, uint32 twapInterval) internal view returns (int256) {
        uint256 marketPrice = _getSqrtMarketTwapX96(baseToken, 0).formatSqrtPriceX96ToPriceX96().formatX96ToX10_18();
        uint256 indexPrice = IIndexPrice(baseToken).getIndexPrice(twapInterval);
        int256 spread =
            marketPrice > indexPrice ? marketPrice.sub(indexPrice).toInt256() : indexPrice.sub(marketPrice).neg256();
        return spread.mulDiv(1e6, indexPrice);
    }

    function _getPnlToBeRealized(InternalRealizePnlParams memory params) internal pure returns (int256) {
        // closedRatio is based on the position size
        uint256 closedRatio = FullMath.mulDiv(params.base.abs(), _FULLY_CLOSED_RATIO, params.takerPositionSize.abs());

        int256 pnlToBeRealized;
        // if closedRatio <= 1, it's reducing or closing a position; else, it's opening a larger reverse position
        if (closedRatio <= _FULLY_CLOSED_RATIO) {
            // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=148137350
            // taker:
            // step 1: long 20 base
            // openNotionalFraction = 252.53
            // openNotional = -252.53
            // step 2: short 10 base (reduce half of the position)
            // quote = 137.5
            // closeRatio = 10/20 = 0.5
            // reducedOpenNotional = openNotional * closedRatio = -252.53 * 0.5 = -126.265
            // realizedPnl = quote + reducedOpenNotional = 137.5 + -126.265 = 11.235
            // openNotionalFraction = openNotionalFraction - quote + realizedPnl
            //                      = 252.53 - 137.5 + 11.235 = 126.265
            // openNotional = -openNotionalFraction = 126.265

            // overflow inspection:
            // max closedRatio = 1e18; range of oldOpenNotional = (-2 ^ 255, 2 ^ 255)
            // only overflow when oldOpenNotional < -2 ^ 255 / 1e18 or oldOpenNotional > 2 ^ 255 / 1e18
            int256 reducedOpenNotional = params.takerOpenNotional.mulDiv(closedRatio.toInt256(), _FULLY_CLOSED_RATIO);
            pnlToBeRealized = params.quote.add(reducedOpenNotional);
        } else {
            // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=668982944
            // taker:
            // step 1: long 20 base
            // openNotionalFraction = 252.53
            // openNotional = -252.53
            // step 2: short 30 base (open a larger reverse position)
            // quote = 337.5
            // closeRatio = 30/20 = 1.5
            // closedPositionNotional = quote / closeRatio = 337.5 / 1.5 = 225
            // remainsPositionNotional = quote - closedPositionNotional = 337.5 - 225 = 112.5
            // realizedPnl = closedPositionNotional + openNotional = -252.53 + 225 = -27.53
            // openNotionalFraction = openNotionalFraction - quote + realizedPnl
            //                      = 252.53 - 337.5 + -27.53 = -112.5
            // openNotional = -openNotionalFraction = remainsPositionNotional = 112.5

            // overflow inspection:
            // max & min tick = 887272, -887272; max liquidity = 2 ^ 128
            // max quote = 2^128 * (sqrt(1.0001^887272) - sqrt(1.0001^-887272)) = 6.276865796e57 < 2^255 / 1e18
            int256 closedPositionNotional = params.quote.mulDiv(int256(_FULLY_CLOSED_RATIO), closedRatio);
            pnlToBeRealized = params.takerOpenNotional.add(closedPositionNotional);
        }

        return pnlToBeRealized;
    }

    // @dev use virtual for testing
    function _getMaxTickCrossedWithinBlockCap() internal pure virtual returns (uint24) {
        return _MAX_TICK_CROSSED_WITHIN_BLOCK_CAP;
    }
}
