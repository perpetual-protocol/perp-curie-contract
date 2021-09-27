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
import { AccountBalance } from "./AccountBalance.sol";
import { ClearingHouseConfig } from "./ClearingHouseConfig.sol";

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
        uint256 deltaAvailableBase;
        uint256 deltaAvailableQuote;
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        uint256 fee;
        uint256 insuranceFundFee;
        int24 tick;
        int256 realizedPnl;
        int256 openNotional;
    }

    struct SwapCallbackData {
        address trader;
        address baseToken;
        address pool;
        uint24 uniswapFeeRatio;
        uint256 fee;
    }

    //
    // STATE
    //

    address public orderBook;
    address public accountBalance;
    address public clearingHouseConfig;

    mapping(address => int24) internal _lastUpdatedTickMap;
    mapping(address => uint256) internal _firstTradedTimestampMap;
    mapping(address => uint256) internal _lastSettledTimestampMap;
    mapping(address => Funding.Growth) internal _globalFundingGrowthX96Map;

    // key: base token
    // value: a threshold to limit the price impact per block when reducing or closing the position
    mapping(address => uint24) private _maxTickCrossedWithinBlockMap;
    //
    // EVENT
    //

    /// @param fundingPayment > 0: payment, < 0 : receipt
    event FundingPaymentSettled(address indexed trader, address indexed baseToken, int256 fundingPayment);
    event FundingUpdated(address indexed baseToken, uint256 markTwap, uint256 indexTwap);

    //
    // EXTERNAL NON-VIEW
    //

    function initialize(
        address marketRegistryArg,
        address orderBookArg,
        address clearingHouseConfigArg
    ) external initializer {
        __ClearingHouseCallee_init(marketRegistryArg);

        // E_OBNC: OrderBook is not contract
        require(orderBookArg.isContract(), "E_OBNC");
        // E_CHNC: CH is not contract
        require(clearingHouseConfigArg.isContract(), "E_CHNC");

        // update states
        orderBook = orderBookArg;
        clearingHouseConfig = clearingHouseConfigArg;
    }

    function setAccountBalance(address accountBalanceArg) external onlyOwner {
        // accountBalance is 0
        require(accountBalanceArg != address(0), "E_AB0");
        accountBalance = accountBalanceArg;
    }

    // solhint-disable-next-line
    function setMaxTickCrossedWithinBlock(address baseToken, uint24 maxTickCrossedWithinBlock) external onlyOwner {
        // EX_ANC: address is not contract
        require(baseToken.isContract(), "EX_ANC");
        // EX_BTNE: base token not exists
        require(MarketRegistry(marketRegistry).getPool(baseToken) != address(0), "EX_BTNE");

        // tick range is [-MAX_TICK, MAX_TICK], maxTickCrossedWithinBlock should be in [0, MAX_TICK]
        // EX_MTCLOOR: max tick crossed limit out of range
        require(maxTickCrossedWithinBlock <= uint24(TickMath.MAX_TICK), "EX_MTCLOOR");

        _maxTickCrossedWithinBlockMap[baseToken] = maxTickCrossedWithinBlock;
    }

    function swap(SwapParams memory params) external onlyClearingHouse returns (SwapResponse memory response) {
        int256 positionSize = AccountBalance(accountBalance).getPositionSize(params.trader, params.baseToken);
        int256 oldOpenNotional = getOpenNotional(params.trader, params.baseToken);
        // is position increased
        bool isOldPositionShort = positionSize < 0 ? true : false;
        bool isIncreasePosition = (positionSize == 0 || isOldPositionShort == params.isBaseToQuote);

        response = _swap(params);

        // examples:
        // https://www.figma.com/file/xuue5qGH4RalX7uAbbzgP3/swap-accounting-and-events?node-id=0%3A1
        AccountBalance(accountBalance).addBalance(
            params.trader,
            params.baseToken,
            response.exchangedPositionSize,
            response.exchangedPositionNotional.sub(response.fee.toInt256()),
            0
        );

        response.openNotional = getOpenNotional(params.trader, params.baseToken);

        // there is only realizedPnl when it's not increasing the position size
        if (!isIncreasePosition) {
            int256 realizedPnl;
            // closedRatio is based on the position size
            uint256 closedRatio = FullMath.mulDiv(response.deltaAvailableBase, 1 ether, positionSize.abs());
            int256 deltaAvailableQuote =
                params.isBaseToQuote
                    ? response.deltaAvailableQuote.toInt256()
                    : -response.deltaAvailableQuote.toInt256();

            // if closedRatio <= 1, it's reducing or closing a position; else, it's opening a larger reverse position
            if (closedRatio <= 1 ether) {
                //https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=148137350
                // taker:
                // step 1: long 20 base
                // openNotionalFraction = 252.53
                // openNotional = -252.53
                // step 2: short 10 base (reduce half of the position)
                // deltaAvailableQuote = 137.5
                // closeRatio = 10/20 = 0.5
                // reducedOpenNotional = oldOpenNotional * closedRatio = -252.53 * 0.5 = -126.265
                // realizedPnl = deltaAvailableQuote + reducedOpenNotional = 137.5 + -126.265 = 11.235
                // openNotionalFraction = oldOpenNotionalFraction - deltaAvailableQuote + realizedPnl
                //                      = 252.53 - 137.5 + 11.235 = 126.265
                // openNotional = -openNotionalFraction = 126.265
                int256 reducedOpenNotional = oldOpenNotional.mul(closedRatio.toInt256()).divBy10_18();
                realizedPnl = deltaAvailableQuote.add(reducedOpenNotional);
            } else {
                //https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=668982944
                // taker:
                // step 1: long 20 base
                // openNotionalFraction = 252.53
                // openNotional = -252.53
                // step 2: short 30 base (open a larger reverse position)
                // deltaAvailableQuote = 337.5
                // closeRatio = 30/20 = 1.5
                // closedPositionNotional = deltaAvailableQuote / closeRatio = 337.5 / 1.5 = 225
                // remainsPositionNotional = deltaAvailableQuote - closedPositionNotional = 337.5 - 225 = 112.5
                // realizedPnl = closedPositionNotional + oldOpenNotional = -252.53 + 225 = -27.53
                // openNotionalFraction = oldOpenNotionalFraction - deltaAvailableQuote + realizedPnl
                //                      = 252.53 - 337.5 + -27.53 = -112.5
                // openNotional = -openNotionalFraction = remainsPositionNotional = 112.5
                int256 closedPositionNotional = deltaAvailableQuote.mul(1 ether).div(closedRatio.toInt256());
                realizedPnl = oldOpenNotional.add(closedPositionNotional);
            }

            if (realizedPnl != 0) {
                // https://app.asana.com/0/1200338471046334/1201034555932071/f
                AccountBalance(accountBalance).settleQuoteToPnl(params.trader, params.baseToken, realizedPnl);
            }
            response.realizedPnl = realizedPnl;
        }

        return response;
    }

    function settleAllFunding(address trader) external {
        address[] memory baseTokens = AccountBalance(accountBalance).getBaseTokens(trader);
        for (uint256 i = 0; i < baseTokens.length; i++) {
            settleFunding(trader, baseTokens[i]);
        }
    }

    /// @dev this function should be called at the beginning of every high-level function, such as openPosition()
    /// this function 1. settles personal funding payment 2. updates global funding growth
    /// personal funding payment is settled whenever there is pending funding payment
    /// the global funding growth update only happens once per unique timestamp (not blockNumber, due to Arbitrum)
    /// @dev it's fine to be called by anyone
    /// @return fundingGrowthGlobal the up-to-date globalFundingGrowth, usually used for later calculations
    function settleFunding(address trader, address baseToken)
        public
        returns (Funding.Growth memory fundingGrowthGlobal)
    {
        uint256 markTwap;
        uint256 indexTwap;
        (fundingGrowthGlobal, markTwap, indexTwap) = getFundingGrowthGlobalAndTwaps(baseToken);

        AccountMarket.Info memory accountInfo = AccountBalance(accountBalance).getAccountInfo(trader, baseToken);
        int256 fundingPayment =
            _updateFundingGrowth(
                trader,
                baseToken,
                accountInfo.baseBalance,
                accountInfo.lastTwPremiumGrowthGlobalX96,
                fundingGrowthGlobal
            );

        if (fundingPayment != 0) {
            AccountBalance(accountBalance).addBalance(trader, address(0), 0, 0, -fundingPayment);
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

        AccountBalance(accountBalance).updateTwPremiumGrowthGlobal(trader, baseToken, fundingGrowthGlobal.twPremiumX96);

        return fundingGrowthGlobal;
    }

    /// @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        // not order book
        require(_msgSender() == orderBook, "E_NOB");
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

    function isOverPriceLimitByReplaySwap(
        address baseToken,
        bool isBaseToQuote,
        int256 positionSize
    ) external returns (bool) {
        ReplaySwapParams memory replaySwapParams =
            ReplaySwapParams({
                baseToken: baseToken,
                isBaseToQuote: !isBaseToQuote,
                isExactInput: !isBaseToQuote,
                amount: positionSize.abs(),
                sqrtPriceLimitX96: _getSqrtPriceLimit(baseToken, isBaseToQuote)
            });
        return isOverPriceLimitWithTick(baseToken, replaySwap(replaySwapParams));
    }

    //
    // EXTERNAL VIEW
    //

    function isOverPriceLimitWithTick(address baseToken, int24 tick) public view returns (bool) {
        uint24 maxTickDelta = _maxTickCrossedWithinBlockMap[baseToken];
        if (maxTickDelta == 0) {
            return false;
        }
        int24 lastUpdatedTick = _lastUpdatedTickMap[baseToken];
        // no overflow/underflow issue because there are range limits for tick and maxTickDelta
        int24 upperTickBound = lastUpdatedTick + int24(maxTickDelta);
        int24 lowerTickBound = lastUpdatedTick - int24(maxTickDelta);
        return (tick < lowerTickBound || tick > upperTickBound);
    }

    function isOverPriceLimit(address baseToken) external view returns (bool) {
        int24 tick = getTick(baseToken);
        return isOverPriceLimitWithTick(baseToken, tick);
    }

    // TODO should be able to remove if we can remove CH._hasPool
    function getPool(address baseToken) external view returns (address) {
        return MarketRegistry(marketRegistry).getPool(baseToken);
    }

    function getMaxTickCrossedWithinBlock(address baseToken) external view returns (uint24) {
        return _maxTickCrossedWithinBlockMap[baseToken];
    }

    function getAllPendingFundingPayment(address trader) external view returns (int256 pendingFundingPayment) {
        address[] memory baseTokens = AccountBalance(accountBalance).getBaseTokens(trader);
        for (uint256 i = 0; i < baseTokens.length; i++) {
            pendingFundingPayment = pendingFundingPayment.add(getPendingFundingPayment(trader, baseTokens[i]));
        }
        return pendingFundingPayment;
    }

    /// @dev this is the view version of _updateFundingGrowth()
    /// @return the pending funding payment of a trader in one market, including liquidity & balance coefficients
    function getPendingFundingPayment(address trader, address baseToken) public view returns (int256) {
        (Funding.Growth memory fundingGrowthGlobal, , ) = getFundingGrowthGlobalAndTwaps(baseToken);
        AccountMarket.Info memory accountInfo = AccountBalance(accountBalance).getAccountInfo(trader, baseToken);

        int256 liquidityCoefficientInFundingPayment =
            OrderBook(orderBook).getLiquidityCoefficientInFundingPayment(trader, baseToken, fundingGrowthGlobal);

        return
            _getPendingFundingPaymentWithLiquidityCoefficient(
                accountInfo.baseBalance,
                accountInfo.lastTwPremiumGrowthGlobalX96,
                fundingGrowthGlobal,
                liquidityCoefficientInFundingPayment
            );
    }

    /// @dev this function calculates the up-to-date globalFundingGrowth and twaps and pass them out
    /// @return fundingGrowthGlobal the up-to-date globalFundingGrowth
    /// @return markTwap only for _settleFundingAndUpdateFundingGrowth()
    /// @return indexTwap only for _settleFundingAndUpdateFundingGrowth()
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
        uint32 twapIntervalArg = ClearingHouseConfig(clearingHouseConfig).twapInterval();
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
        indexTwap = IIndexPrice(baseToken).getIndexPrice(twapIntervalArg);

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

    function getTick(address baseToken) public view returns (int24) {
        return UniswapV3Broker.getTick(MarketRegistry(marketRegistry).getPool(baseToken));
    }

    function getSqrtMarkTwapX96(address baseToken, uint32 twapInterval) public view returns (uint160) {
        return UniswapV3Broker.getSqrtMarkTwapX96(MarketRegistry(marketRegistry).getPool(baseToken), twapInterval);
    }

    /// @dev the amount of quote token paid for a position when opening
    function getOpenNotional(address trader, address baseToken) public view returns (int256) {
        // quote.pool[baseToken] + quote.owedFee[baseToken] + quoteBalance[baseToken]
        // https://www.notion.so/perp/Perpetual-Swap-Contract-s-Specs-Simulations-96e6255bf77e4c90914855603ff7ddd1

        return
            OrderBook(orderBook).getTotalTokenAmountInPool(trader, baseToken, false).toInt256().add(
                AccountBalance(accountBalance).getQuote(trader, baseToken)
            );
    }

    //
    // INTERNAL NON-VIEW
    //

    /// @return the resulting tick (derived from price) after replaying the swap
    function replaySwap(ReplaySwapParams memory params) internal returns (int24) {
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

    /// @dev customized fee: https://www.notion.so/perp/Customise-fee-tier-on-B2QFee-1b7244e1db63416c8651e8fa04128cdb
    function _swap(SwapParams memory params) internal returns (SwapResponse memory) {
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

        // as we charge fees in ClearingHouse instead of in Uniswap pools,
        // we need to scale up base or quote amounts to get the exact exchanged position size and notional
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

        // update the timestamp of the first tx in this market
        if (_firstTradedTimestampMap[params.baseToken] == 0) {
            _firstTradedTimestampMap[params.baseToken] = _blockTimestamp();
        }

        return
            SwapResponse({
                deltaAvailableBase: exchangedPositionSize.abs(),
                deltaAvailableQuote: exchangedPositionNotional.sub(replayResponse.fee.toInt256()).abs(),
                exchangedPositionSize: exchangedPositionSize,
                exchangedPositionNotional: exchangedPositionNotional,
                realizedPnl: 0,
                fee: replayResponse.fee,
                insuranceFundFee: replayResponse.insuranceFundFee,
                tick: replayResponse.tick,
                openNotional: 0
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
            OrderBook(orderBook).updateFundingGrowthAndLiquidityCoefficientInFundingPayment(
                trader,
                baseToken,
                fundingGrowthGlobal
            );

        return
            _getPendingFundingPaymentWithLiquidityCoefficient(
                baseBalance,
                twPremiumGrowthGlobalX96,
                fundingGrowthGlobal,
                liquidityCoefficientInFundingPayment
            );
    }

    //
    // INTERNAL VIEW
    //

    function _getSqrtPriceLimit(address baseToken, bool isLong) internal view returns (uint160) {
        int24 lastUpdatedTick = _lastUpdatedTickMap[baseToken];
        uint24 maxTickDelta = _maxTickCrossedWithinBlockMap[baseToken];
        int24 tickBoundary =
            isLong ? lastUpdatedTick + int24(maxTickDelta) + 1 : lastUpdatedTick - int24(maxTickDelta) - 1;
        return TickMath.getSqrtRatioAtTick(tickBoundary);
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

    function _getPendingFundingPaymentWithLiquidityCoefficient(
        int256 baseBalance,
        int256 twPremiumGrowthGlobalX96,
        Funding.Growth memory fundingGrowthGlobal,
        int256 liquidityCoefficientInFundingPayment
    ) internal pure returns (int256) {
        int256 balanceCoefficientInFundingPayment =
            AccountMarket.getBalanceCoefficientInFundingPayment(
                baseBalance,
                fundingGrowthGlobal.twPremiumX96,
                twPremiumGrowthGlobalX96
            );

        return liquidityCoefficientInFundingPayment.add(balanceCoefficientInFundingPayment).div(1 days);
    }
}
