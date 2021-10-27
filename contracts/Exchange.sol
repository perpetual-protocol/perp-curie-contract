// SPDX-License-Identifier: GPL-2.0-or-later
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
import { FeeMath } from "./lib/FeeMath.sol";
import { PerpFixedPoint96 } from "./lib/PerpFixedPoint96.sol";
import { Funding } from "./lib/Funding.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { AccountMarket } from "./lib/AccountMarket.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { ClearingHouseCallee } from "./base/ClearingHouseCallee.sol";
import { UniswapV3CallbackBridge } from "./base/UniswapV3CallbackBridge.sol";
import { IOrderBook } from "./interface/IOrderBook.sol";
import { IMarketRegistry } from "./interface/IMarketRegistry.sol";
import { IAccountBalance } from "./interface/IAccountBalance.sol";
import { IClearingHouseConfig } from "./interface/IClearingHouseConfig.sol";
import { ExchangeStorageV1 } from "./storage/ExchangeStorage.sol";
import { IExchange } from "./interface/IExchange.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract Exchange is
    IUniswapV3SwapCallback,
    IExchange,
    BlockContext,
    ClearingHouseCallee,
    UniswapV3CallbackBridge,
    ExchangeStorageV1
{
    using AddressUpgradeable for address;
    using SafeMathUpgradeable for uint256;
    using SignedSafeMathUpgradeable for int256;
    using SignedSafeMathUpgradeable for int24;
    using PerpMath for uint256;
    using PerpMath for uint160;
    using PerpMath for int256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;

    // CONSTANT
    uint256 internal constant _FULL_CLOSED_RATIO = 1e18;

    //
    // STRUCT
    //

    struct InternalReplaySwapParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96;
    }

    struct InternalSwapResponse {
        uint256 deltaAvailableBase;
        uint256 deltaAvailableQuote;
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        uint256 fee;
        uint256 insuranceFundFee;
        int24 tick;
    }

    //
    // EXTERNAL NON-VIEW
    //

    function initialize(
        address marketRegistryArg,
        address orderBookArg,
        address clearingHouseConfigArg,
        address insuranceFundArg
    ) external initializer {
        __ClearingHouseCallee_init();
        __UniswapV3CallbackBridge_init(marketRegistryArg);

        // E_OBNC: OrderBook is not contract
        require(orderBookArg.isContract(), "E_OBNC");
        // E_CHNC: CH is not contract
        require(clearingHouseConfigArg.isContract(), "E_CHNC");
        // E_IFANC: InsuranceFund address is not contract
        require(insuranceFundArg.isContract(), "E_IFANC");

        // update states
        _insuranceFund = insuranceFundArg;
        _orderBook = orderBookArg;
        _clearingHouseConfig = clearingHouseConfigArg;
    }

    function setAccountBalance(address accountBalanceArg) external onlyOwner {
        // accountBalance is 0
        require(accountBalanceArg != address(0), "E_AB0");
        _accountBalance = accountBalanceArg;
        emit AccountBalanceChanged(accountBalanceArg);
    }

    // solhint-disable-next-line
    function setMaxTickCrossedWithinBlock(address baseToken, uint24 maxTickCrossedWithinBlock) external onlyOwner {
        // EX_ANC: address is not contract
        require(baseToken.isContract(), "EX_ANC");
        // EX_BTNE: base token not exists
        require(IMarketRegistry(_marketRegistry).getPool(baseToken) != address(0), "EX_BTNE");

        // tick range is [MIN_TICK, MAX_TICK], maxTickCrossedWithinBlock should be in [0, MAX_TICK - MIN_TICK]
        // EX_MTCLOOR: max tick crossed limit out of range
        require(maxTickCrossedWithinBlock <= (TickMath.MAX_TICK.sub(TickMath.MIN_TICK)).toUint24(), "EX_MTCLOOR");

        _maxTickCrossedWithinBlockMap[baseToken] = maxTickCrossedWithinBlock;

        emit MaxTickCrossedWithinBlockChanged(baseToken, maxTickCrossedWithinBlock);
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override checkCallback {
        IUniswapV3SwapCallback(_clearingHouse).uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    function swap(SwapParams memory params) external override onlyClearingHouse returns (SwapResponse memory) {
        int256 positionSize = IAccountBalance(_accountBalance).getPositionSize(params.trader, params.baseToken);
        // is position increased
        bool isOldPositionShort = positionSize < 0;
        bool isReducePosition = !(positionSize == 0 || isOldPositionShort == params.isBaseToQuote);
        bool isPartialClose;

        // if over price limit when
        // 1. close a position, then partial close the position
        // 2. reduce a position, then revert
        if (params.isClose) {
            // if trader is on long side, baseToQuote: true, exactInput: true
            // if trader is on short side, baseToQuote: false (quoteToBase), exactInput: false (exactOutput)
            // simulate the tx to see if it _isOverPriceLimit; if true, can partially close the position only once
            if (
                _isOverPriceLimit(params.baseToken) ||
                _isOverPriceLimitByReplaySwap(params.baseToken, isOldPositionShort, positionSize)
            ) {
                // EX_AOPLO: already over price limit once
                require(
                    _blockTimestamp() != _lastOverPriceLimitTimestampMap[params.trader][params.baseToken],
                    "EX_AOPLO"
                );
                _lastOverPriceLimitTimestampMap[params.trader][params.baseToken] = _blockTimestamp();
                params.amount = positionSize.abs().mulRatio(
                    IClearingHouseConfig(_clearingHouseConfig).getPartialCloseRatio()
                );
                isPartialClose = true;
            }
        } else {
            if (isReducePosition) {
                // EX_OPIBS: over price limit before swap
                require(!_isOverPriceLimit(params.baseToken), "EX_OPIBS");
            }
        }

        int256 oldOpenNotional = getOpenNotional(params.trader, params.baseToken);

        InternalSwapResponse memory response = _swap(params);

        if (!params.isClose && isReducePosition) {
            require(!_isOverPriceLimitWithTick(params.baseToken, response.tick), "EX_OPIAS");
        }

        // examples:
        // https://www.figma.com/file/xuue5qGH4RalX7uAbbzgP3/swap-accounting-and-events?node-id=0%3A1
        IAccountBalance(_accountBalance).addBalance(
            params.trader,
            params.baseToken,
            response.exchangedPositionSize,
            response.exchangedPositionNotional.sub(response.fee.toInt256()),
            0
        );

        int256 realizedPnl;

        // there is only realizedPnl when it's not increasing the position size
        if (isReducePosition) {
            // closedRatio is based on the position size
            uint256 closedRatio = FullMath.mulDiv(response.deltaAvailableBase, _FULL_CLOSED_RATIO, positionSize.abs());
            int256 deltaAvailableQuote =
                params.isBaseToQuote ? response.deltaAvailableQuote.toInt256() : response.deltaAvailableQuote.neg256();

            // if closedRatio <= 1 (decimals = 18),
            // it's reducing or closing a position; else, it's opening a larger reverse position
            if (closedRatio <= _FULL_CLOSED_RATIO) {
                //https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=148137350
                // taker:
                // step 1: long 20 base
                // openNotionalFraction = 252.53
                // openNotional = -252.53
                // step 2: short 10 base (reduce half of the position)
                // deltaAvailableQuote = 137.5
                // closeRatio = 10/20 = 0.5
                // reducedOpenNotional = openNotional * closedRatio = -252.53 * 0.5 = -126.265
                // realizedPnl = deltaAvailableQuote + reducedOpenNotional = 137.5 + -126.265 = 11.235
                // openNotionalFraction = openNotionalFraction - deltaAvailableQuote + realizedPnl
                //                      = 252.53 - 137.5 + 11.235 = 126.265
                // openNotional = -openNotionalFraction = 126.265
                // overflow inspection:
                // maximum of closedRatio = 1e18
                // range of oldOpenNotional = [-2^255 / 1e18, 2^255 / 1e18]
                // only overflow when oldOpenNotional < -2^255 / 1e18 or oldOpenNotional > 2^255 / 1e18.
                int256 reducedOpenNotional =
                    oldOpenNotional.mul(closedRatio.toInt256()).div(int256(_FULL_CLOSED_RATIO));
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
                // realizedPnl = closedPositionNotional + openNotional = -252.53 + 225 = -27.53
                // openNotionalFraction = openNotionalFraction - deltaAvailableQuote + realizedPnl
                //                      = 252.53 - 337.5 + -27.53 = -112.5
                // openNotional = -openNotionalFraction = remainsPositionNotional = 112.5
                // overflow inspection:
                // Due to price limitation,
                // assume the max tick = 887272 and max of liquidity = 2^128
                // max of delta quote = (sqrt(1.0001^887272) - 1) * 2**128 = 6.2768658e+57 < 2^255/1e18
                int256 closedPositionNotional =
                    deltaAvailableQuote.mul(int256(_FULL_CLOSED_RATIO)).div(closedRatio.toInt256());
                realizedPnl = oldOpenNotional.add(closedPositionNotional);
            }

            if (realizedPnl != 0) {
                // https://app.asana.com/0/1200338471046334/1201034555932071/f
                IAccountBalance(_accountBalance).settleQuoteToPnl(params.trader, params.baseToken, realizedPnl);
            }
        }
        int256 openNotional = getOpenNotional(params.trader, params.baseToken);

        IAccountBalance(_accountBalance).addOwedRealizedPnl(_insuranceFund, response.insuranceFundFee.toInt256());
        uint256 sqrtPrice =
            UniswapV3Broker.getSqrtMarkPriceX96(IMarketRegistry(_marketRegistry).getPool(params.baseToken));
        emit PositionChanged(
            params.trader,
            params.baseToken,
            response.exchangedPositionSize,
            response.exchangedPositionNotional,
            response.fee,
            openNotional,
            realizedPnl,
            sqrtPrice
        );

        return
            SwapResponse({
                deltaAvailableBase: response.deltaAvailableBase,
                deltaAvailableQuote: response.deltaAvailableQuote,
                exchangedPositionSize: response.exchangedPositionSize,
                exchangedPositionNotional: response.exchangedPositionNotional,
                tick: response.tick,
                isPartialClose: isPartialClose
            });
    }

    function settleAllFunding(address trader) external override {
        address[] memory baseTokens = IAccountBalance(_accountBalance).getBaseTokens(trader);
        uint256 baseTokenLength = baseTokens.length;

        for (uint256 i = 0; i < baseTokenLength; i++) {
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
        override
        returns (Funding.Growth memory fundingGrowthGlobal)
    {
        // EX_BTNE: base token not exists
        require(IMarketRegistry(_marketRegistry).getPool(baseToken) != address(0), "EX_BTNE");

        uint256 markTwap;
        uint256 indexTwap;
        (fundingGrowthGlobal, markTwap, indexTwap) = getFundingGrowthGlobalAndTwaps(baseToken);

        AccountMarket.Info memory accountInfo = IAccountBalance(_accountBalance).getAccountInfo(trader, baseToken);
        int256 fundingPayment =
            _updateFundingGrowth(
                trader,
                baseToken,
                accountInfo.baseBalance,
                accountInfo.lastTwPremiumGrowthGlobalX96,
                fundingGrowthGlobal
            );

        if (fundingPayment != 0) {
            IAccountBalance(_accountBalance).addBalance(trader, address(0), 0, 0, fundingPayment.neg256());
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

        IAccountBalance(_accountBalance).updateTwPremiumGrowthGlobal(
            trader,
            baseToken,
            fundingGrowthGlobal.twPremiumX96
        );

        return fundingGrowthGlobal;
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
    function getInsuranceFund() external view override returns (address) {
        return _insuranceFund;
    }

    function getMaxTickCrossedWithinBlock(address baseToken) external view override returns (uint24) {
        return _maxTickCrossedWithinBlockMap[baseToken];
    }

    function getAllPendingFundingPayment(address trader) external view override returns (int256 pendingFundingPayment) {
        address[] memory baseTokens = IAccountBalance(_accountBalance).getBaseTokens(trader);
        for (uint256 i = 0; i < baseTokens.length; i++) {
            pendingFundingPayment = pendingFundingPayment.add(getPendingFundingPayment(trader, baseTokens[i]));
        }
        return pendingFundingPayment;
    }

    /// @dev this is the view version of _updateFundingGrowth()
    /// @return the pending funding payment of a trader in one market, including liquidity & balance coefficients
    function getPendingFundingPayment(address trader, address baseToken) public view override returns (int256) {
        (Funding.Growth memory fundingGrowthGlobal, , ) = getFundingGrowthGlobalAndTwaps(baseToken);
        AccountMarket.Info memory accountInfo = IAccountBalance(_accountBalance).getAccountInfo(trader, baseToken);

        int256 liquidityCoefficientInFundingPayment =
            IOrderBook(_orderBook).getLiquidityCoefficientInFundingPayment(trader, baseToken, fundingGrowthGlobal);

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
    /// @return markTwap only for settleAllFunding()
    /// @return indexTwap only for settleAllFunding()
    function getFundingGrowthGlobalAndTwaps(address baseToken)
        public
        view
        override
        returns (
            Funding.Growth memory fundingGrowthGlobal,
            uint256 markTwap,
            uint256 indexTwap
        )
    {
        Funding.Growth storage lastFundingGrowthGlobal = _globalFundingGrowthX96Map[baseToken];

        // get mark twap
        uint32 twapIntervalArg = IClearingHouseConfig(_clearingHouseConfig).getTwapInterval();
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

    function getTick(address baseToken) public view override returns (int24) {
        return UniswapV3Broker.getTick(IMarketRegistry(_marketRegistry).getPool(baseToken));
    }

    function getSqrtMarkTwapX96(address baseToken, uint32 twapInterval) public view override returns (uint160) {
        return UniswapV3Broker.getSqrtMarkTwapX96(IMarketRegistry(_marketRegistry).getPool(baseToken), twapInterval);
    }

    /// @dev the amount of quote token paid for a position when opening
    function getOpenNotional(address trader, address baseToken) public view override returns (int256) {
        // quote.pool[baseToken] + quote.owedFee[baseToken] + quoteBalance[baseToken]
        // https://www.notion.so/perp/Perpetual-Swap-Contract-s-Specs-Simulations-96e6255bf77e4c90914855603ff7ddd1

        return
            IOrderBook(_orderBook).getTotalTokenAmountInPool(trader, baseToken, false).toInt256().add(
                IAccountBalance(_accountBalance).getQuote(trader, baseToken)
            );
    }

    //
    // INTERNAL NON-VIEW
    //

    function _isOverPriceLimitByReplaySwap(
        address baseToken,
        bool isBaseToQuote,
        int256 positionSize
    ) internal returns (bool) {
        // replaySwap: the given sqrtPriceLimitX96 is corresponding max tick + 1 or min tick - 1,
        InternalReplaySwapParams memory replaySwapParams =
            InternalReplaySwapParams({
                baseToken: baseToken,
                isBaseToQuote: !isBaseToQuote,
                isExactInput: !isBaseToQuote,
                amount: positionSize.abs(),
                sqrtPriceLimitX96: _getSqrtPriceLimit(baseToken, isBaseToQuote)
            });
        return _isOverPriceLimitWithTick(baseToken, _replaySwap(replaySwapParams));
    }

    /// @return the resulting tick (derived from price) after replaying the swap
    function _replaySwap(InternalReplaySwapParams memory params) internal returns (int24) {
        IMarketRegistry.MarketInfo memory marketInfo = IMarketRegistry(_marketRegistry).getMarketInfo(params.baseToken);
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
        IOrderBook.ReplaySwapResponse memory response =
            IOrderBook(_orderBook).replaySwap(
                IOrderBook.ReplaySwapParams({
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
    function _swap(SwapParams memory params) internal returns (InternalSwapResponse memory) {
        IMarketRegistry.MarketInfo memory marketInfo = IMarketRegistry(_marketRegistry).getMarketInfo(params.baseToken);

        (uint256 scaledAmountForUniswapV3PoolSwap, int256 signedScaledAmountForReplaySwap) =
            _getScaledAmountForSwaps(
                params.isBaseToQuote,
                params.isExactInput,
                params.amount,
                marketInfo.exchangeFeeRatio,
                marketInfo.uniswapFeeRatio
            );

        // simulate the swap to calculate the fees charged in exchange
        IOrderBook.ReplaySwapResponse memory replayResponse =
            IOrderBook(_orderBook).replaySwap(
                IOrderBook.ReplaySwapParams({
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

        // as we charge fees in ClearingHouse instead of in Uniswap pools,
        // we need to scale up base or quote amounts to get the exact exchanged position size and notional
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        if (params.isBaseToQuote) {
            // short: exchangedPositionSize <= 0 && exchangedPositionNotional >= 0
            exchangedPositionSize = FeeMath
                .calcAmountScaledByFeeRatio(response.base, marketInfo.uniswapFeeRatio, false)
                .neg256();
            // due to base to quote fee, exchangedPositionNotional contains the fee
            // s.t. we can take the fee away from exchangedPositionNotional
            exchangedPositionNotional = response.quote.toInt256();
        } else {
            // long: exchangedPositionSize >= 0 && exchangedPositionNotional <= 0
            exchangedPositionSize = response.base.toInt256();
            exchangedPositionNotional = FeeMath
                .calcAmountScaledByFeeRatio(response.quote, marketInfo.uniswapFeeRatio, false)
                .neg256();
        }

        // update the timestamp of the first tx in this market
        if (_firstTradedTimestampMap[params.baseToken] == 0) {
            _firstTradedTimestampMap[params.baseToken] = _blockTimestamp();
        }

        return
            InternalSwapResponse({
                deltaAvailableBase: exchangedPositionSize.abs(),
                deltaAvailableQuote: exchangedPositionNotional.sub(replayResponse.fee.toInt256()).abs(),
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

    function _isOverPriceLimitWithTick(address baseToken, int24 tick) internal view returns (bool) {
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

    function _isOverPriceLimit(address baseToken) internal view returns (bool) {
        int24 tick = getTick(baseToken);
        return _isOverPriceLimitWithTick(baseToken, tick);
    }

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
            : signedScaledAmountForReplaySwap.neg256();
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

        return
            liquidityCoefficientInFundingPayment.add(balanceCoefficientInFundingPayment).div(_VIRTUAL_FUNDING_PERIOD);
    }
}
