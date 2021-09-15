// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { AccountMarket } from "./lib/AccountMarket.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { ClearingHouseCallee } from "./base/ClearingHouseCallee.sol";
import { Funding } from "./lib/Funding.sol";
import { Exchange } from "./Exchange.sol";
import { OrderBook } from "./OrderBook.sol";
import { ClearingHouseConfig } from "./ClearingHouseConfig.sol";
import { ArbBlockContext } from "./arbitrum/ArbBlockContext.sol";
import { PerpFixedPoint96 } from "./lib/PerpFixedPoint96.sol";

contract AccountBalance is ClearingHouseCallee, ArbBlockContext {
    using AddressUpgradeable for address;
    using SafeMathUpgradeable for uint256;
    using SignedSafeMathUpgradeable for int256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;
    using PerpMath for uint256;
    using PerpMath for int256;
    using PerpMath for uint160;
    using AccountMarket for AccountMarket.Info;

    address public config;
    address public exchange;
    address public orderBook;

    // first key: trader, second key: baseToken
    mapping(address => mapping(address => AccountMarket.Info)) internal _accountMarketMap;

    function initialize(
        address configArg,
        address marketRegistryArg,
        address exchangeArg
    ) public initializer {
        // ClearingHouseConfig address is not contract
        require(configArg.isContract(), "CH_CCNC");
        // CH_ANC: address is not contract
        require(exchangeArg.isContract(), "AB_ANC");

        address orderBookArg = Exchange(exchangeArg).orderBook();
        // orderbook is not contarct
        require(orderBookArg.isContract(), "AB_OBNC");

        __ClearingHouseCallee_init(marketRegistryArg);

        config = configArg;
        exchange = exchangeArg;
        orderBook = orderBookArg;
    }

    function addBase(
        address trader,
        address baseToken,
        int256 delta
    ) external onlyClearingHouse {
        AccountMarket.Info storage accountInfo = _accountMarketMap[trader][baseToken];
        accountInfo.baseBalance = accountInfo.baseBalance.add(delta);
    }

    function addQuote(
        address trader,
        address baseToken,
        int256 delta
    ) external onlyClearingHouse {
        AccountMarket.Info storage accountInfo = _accountMarketMap[trader][baseToken];
        accountInfo.quoteBalance = accountInfo.quoteBalance.add(delta);
    }

    function _updateFundingGrowthAngFundingPayment(
        address trader,
        address baseToken,
        int256 liquidityCoefficientInFundingPayment,
        int256 updatedGlobalFundingGrowthTwPremiumX96
    ) internal returns (int256) {
        return
            _accountMarketMap[trader][baseToken].updateFundingGrowthAngFundingPayment(
                liquidityCoefficientInFundingPayment,
                updatedGlobalFundingGrowthTwPremiumX96
            );
    }

    function clearBalance(address trader, address baseToken) external onlyClearingHouse {
        delete _accountMarketMap[trader][baseToken];
    }

    function getBase(address trader, address baseToken) external view returns (int256) {
        return _accountMarketMap[trader][baseToken].baseBalance;
    }

    function getQuote(address trader, address baseToken) external view returns (int256) {
        return _accountMarketMap[trader][baseToken].quoteBalance;
    }

    // moved from ch

    //
    // AccountBalance.owedRealizedpnl
    //

    // trader => owedRealizedPnl
    mapping(address => int256) internal _owedRealizedPnlMap;

    function getOwedRealizedPnl(address trader) public view returns (int256) {
        return _owedRealizedPnlMap[trader];
    }

    function addOwedRealizedPnl(address trader, int256 delta) public {
        _owedRealizedPnlMap[trader] = _owedRealizedPnlMap[trader].add(delta);
    }

    function clearOwedRealizedPnl(address trader) public {
        _owedRealizedPnlMap[trader] = 0;
    }

    //
    // TODO move to acocunt balance
    // funding related
    //

    // key: base token
    mapping(address => uint256) internal _firstTradedTimestampMap;
    mapping(address => uint256) internal _lastSettledTimestampMap;
    mapping(address => Funding.Growth) internal _globalFundingGrowthX96Map;

    // value: tick from the last tx; used for comparing if a tx exceeds maxTickCrossedWithinBlock
    mapping(address => int24) internal _lastUpdatedTickMap;

    event FundingPaymentSettled(
        address indexed trader,
        address indexed baseToken,
        int256 amount // +: trader pays, -: trader receives
    );
    event FundingUpdated(address indexed baseToken, uint256 markTwap, uint256 indexTwap);

    function getFirstTradedTimestamp(address baseToken) public view returns (uint256) {
        return _firstTradedTimestampMap[baseToken];
    }

    function updateFirstTradedTimestamp(address baseToken) public {
        _firstTradedTimestampMap[baseToken] = _blockTimestamp();
    }

    function getLastUpdatedTickMap(address baseToken) public view returns (int24) {
        return _lastUpdatedTickMap[baseToken];
    }

    /// @dev this function should be called at the beginning of every high-level function, such as openPosition()
    /// @dev this function 1. settles personal funding payment 2. updates global funding growth
    /// @dev personal funding payment is settled whenever there is pending funding payment
    /// @dev the global funding growth update only happens once per unique timestamp (not blockNumber, due to Arbitrum)
    /// @return fundingGrowthGlobal the up-to-date globalFundingGrowth, usually used for later calculations
    function settleFundingAndUpdateFundingGrowth(address trader, address baseToken)
        external
        onlyClearingHouse
        returns (Funding.Growth memory fundingGrowthGlobal)
    {
        uint256 markTwap;
        uint256 indexTwap;
        (fundingGrowthGlobal, markTwap, indexTwap) = _getFundingGrowthGlobalAndTwaps(baseToken);

        // pass fundingGrowthGlobal in for states mutation
        int256 fundingPayment = _updateFundingGrowthAndFundingPayment(trader, baseToken, fundingGrowthGlobal);

        if (fundingPayment != 0) {
            addOwedRealizedPnl(trader, -fundingPayment);
            emit FundingPaymentSettled(trader, baseToken, fundingPayment);
        }

        // update states before further actions in this block; once per block
        if (_lastSettledTimestampMap[baseToken] != _blockTimestamp()) {
            // update fundingGrowthGlobal
            Funding.Growth storage lastFundingGrowthGlobal = _globalFundingGrowthX96Map[baseToken];
            (
                _lastSettledTimestampMap[baseToken],
                lastFundingGrowthGlobal.twPremiumX96,
                lastFundingGrowthGlobal.twPremiumDivBySqrtPriceX96
            ) = (_blockTimestamp(), fundingGrowthGlobal.twPremiumX96, fundingGrowthGlobal.twPremiumDivBySqrtPriceX96);

            // update tick
            _lastUpdatedTickMap[baseToken] = Exchange(exchange).getTick(baseToken);

            emit FundingUpdated(baseToken, markTwap, indexTwap);
        }

        return fundingGrowthGlobal;
    }

    /// @dev this is the non-view version of _getPendingFundingPayment()
    /// @return fundingPayment the funding payment of a market, including liquidity & availableAndDebt coefficients
    function _updateFundingGrowthAndFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory fundingGrowthGlobal
    ) internal returns (int256 fundingPayment) {
        int256 liquidityCoefficientInFundingPayment =
            OrderBook(orderBook).updateFundingGrowthAndLiquidityCoefficientInFundingPayment(
                trader,
                baseToken,
                fundingGrowthGlobal
            );

        return
            _updateFundingGrowthAngFundingPayment(
                trader,
                baseToken,
                liquidityCoefficientInFundingPayment,
                fundingGrowthGlobal.twPremiumX96
            );
    }

    // TODO change to internal after updating swap test
    /// @dev this function calculates the up-to-date globalFundingGrowth and twaps and pass them out
    /// @return fundingGrowthGlobal the up-to-date globalFundingGrowth
    /// @return markTwap only for _settleFundingAndUpdateFundingGrowth()
    /// @return indexTwap only for _settleFundingAndUpdateFundingGrowth()
    function _getFundingGrowthGlobalAndTwaps(address baseToken)
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

        uint256 markTwapX96 =
            Exchange(exchange).getSqrtMarkTwapX96(baseToken, twapIntervalArg).formatSqrtPriceX96ToPriceX96();
        markTwap = markTwapX96.formatX96ToX10_18();
        indexTwap = _getIndexPrice(baseToken);

        uint256 lastSettledTimestamp = _lastSettledTimestampMap[baseToken];
        if (lastSettledTimestamp != _blockTimestamp() && lastSettledTimestamp != 0) {
            int256 twPremiumDeltaX96 =
                markTwapX96.toInt256().sub(indexTwap.formatX10_18ToX96().toInt256()).mul(
                    _blockTimestamp().sub(lastSettledTimestamp).toInt256()
                );
            fundingGrowthGlobal.twPremiumX96 = lastFundingGrowthGlobal.twPremiumX96.add(twPremiumDeltaX96);

            // overflow inspection:
            // assuming premium = 1 billion (1e9), time diff = 1 year (3600 * 24 * 365)
            // log(1e9 * 2^96 * (3600 * 24 * 365) * 2^96) / log(2) = 246.8078491997 < 255
            fundingGrowthGlobal.twPremiumDivBySqrtPriceX96 = lastFundingGrowthGlobal.twPremiumDivBySqrtPriceX96.add(
                (twPremiumDeltaX96.mul(PerpFixedPoint96.IQ96)).div(
                    uint256(Exchange(exchange).getSqrtMarkTwapX96(baseToken, 0)).toInt256()
                )
            );
        } else {
            // if this is the latest updated block, values in _globalFundingGrowthX96Map are up-to-date already
            fundingGrowthGlobal = lastFundingGrowthGlobal;
        }

        return (fundingGrowthGlobal, markTwap, indexTwap);
    }

    /// @return fundingPayment the funding payment of a market of a trader; > 0 is payment and < 0 is receipt
    function getPendingFundingPayment(address trader, address baseToken) public view returns (int256) {
        (Funding.Growth memory fundingGrowthGlobal, , ) = _getFundingGrowthGlobalAndTwaps(baseToken);
        return _getPendingFundingPayment(trader, baseToken, fundingGrowthGlobal);
    }

    /// @dev this is the view version of _updateFundingGrowthAndFundingPayment()
    /// @return fundingPayment the funding payment of a market, including liquidity & availableAndDebt coefficients
    function _getPendingFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory fundingGrowthGlobal
    ) internal view returns (int256 fundingPayment) {
        int256 liquidityCoefficientInFundingPayment =
            OrderBook(orderBook).getLiquidityCoefficientInFundingPayment(trader, baseToken, fundingGrowthGlobal);

        return
            _accountMarketMap[trader][baseToken].getPendingFundingPayment(
                liquidityCoefficientInFundingPayment,
                fundingGrowthGlobal.twPremiumX96
            );
    }

    function _getIndexPrice(address baseToken) internal view returns (uint256) {
        return IIndexPrice(baseToken).getIndexPrice(_getTwapInterval());
    }

    function _getTwapInterval() internal view returns (uint32) {
        return ClearingHouseConfig(config).twapInterval();
    }
}
