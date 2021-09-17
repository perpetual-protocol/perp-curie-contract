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

    //
    // State
    //
    address public clearingHouseConfig;
    address public exchange;
    address public orderBook;
    address public vault;

    // 10 wei
    uint256 internal constant _DUST = 10;

    // key: base token
    mapping(address => uint256) internal _firstTradedTimestampMap;
    mapping(address => uint256) internal _lastSettledTimestampMap;
    mapping(address => Funding.Growth) internal _globalFundingGrowthX96Map;

    // trader => owedRealizedPnl
    mapping(address => int256) internal _owedRealizedPnlMap;

    // trader => baseTokens
    // base token registry of each trader
    mapping(address => address[]) internal _baseTokensMap;

    // first key: trader, second key: baseToken
    mapping(address => mapping(address => AccountMarket.Info)) internal _accountMarketMap;

    // value: tick from the last tx; used for comparing if a tx exceeds maxTickCrossedWithinBlock
    mapping(address => int24) internal _lastUpdatedTickMap;

    //
    // Event
    //
    event FundingPaymentSettled(
        address indexed trader,
        address indexed baseToken,
        int256 amount // +: trader pays, -: trader receives
    );
    event FundingUpdated(address indexed baseToken, uint256 markTwap, uint256 indexTwap);

    //
    // Constructor
    //
    function initialize(
        address clearingHouseConfigArg,
        address marketRegistryArg,
        address exchangeArg
    ) external initializer {
        // ClearingHouseConfig address is not contract
        require(clearingHouseConfigArg.isContract(), "AB_CCNC");
        // Exchange is not contract
        require(exchangeArg.isContract(), "AB_EXNC");

        address orderBookArg = Exchange(exchangeArg).orderBook();
        // OrderBook is not contarct
        require(orderBookArg.isContract(), "AB_OBNC");

        __ClearingHouseCallee_init(marketRegistryArg);

        clearingHouseConfig = clearingHouseConfigArg;
        exchange = exchangeArg;
        orderBook = orderBookArg;
    }

    //
    // External Admin Setter
    //
    function setVault(address vaultArg) external onlyOwner {
        // vault address is not contract
        require(vaultArg.isContract(), "AB_VNC");
        vault = vaultArg;
    }

    //
    // External onlyClearingHouse
    //
    function addBalance(
        address trader,
        address baseToken,
        int256 base,
        int256 quote,
        int256 owedRealizedPnl
    ) external onlyClearingHouse {
        AccountMarket.Info storage accountInfo = _accountMarketMap[trader][baseToken];
        accountInfo.baseBalance = accountInfo.baseBalance.add(base);
        accountInfo.quoteBalance = accountInfo.quoteBalance.add(quote);
        _owedRealizedPnlMap[trader] = _owedRealizedPnlMap[trader].add(owedRealizedPnl);
    }

    function settleQuoteToPnl(
        address trader,
        address baseToken,
        int256 amount
    ) external onlyClearingHouse {
        AccountMarket.Info storage accountInfo = _accountMarketMap[trader][baseToken];
        accountInfo.quoteBalance = accountInfo.quoteBalance.sub(amount);
        _owedRealizedPnlMap[trader] = _owedRealizedPnlMap[trader].add(amount);
    }

    function addOwedRealizedPnl(address trader, int256 delta) external onlyClearingHouse {
        _owedRealizedPnlMap[trader] = _owedRealizedPnlMap[trader].add(delta);
    }

    function updateFirstTradedTimestamp(address baseToken) external onlyClearingHouse {
        _firstTradedTimestampMap[baseToken] = _blockTimestamp();
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
        return _settleFundingAndUpdateFundingGrowth(trader, baseToken);
    }

    /// @dev this function is expensive
    function deregisterBaseToken(address trader, address baseToken) external onlyClearingHouse {
        if (getBase(trader, baseToken).abs() >= _DUST || getQuote(trader, baseToken).abs() >= _DUST) {
            return;
        }

        uint256 baseInPool = OrderBook(orderBook).getTotalTokenAmountInPool(trader, baseToken, true);
        uint256 quoteInPool = OrderBook(orderBook).getTotalTokenAmountInPool(trader, baseToken, false);
        if (baseInPool > 0 || quoteInPool > 0) {
            return;
        }

        delete _accountMarketMap[trader][baseToken];

        uint256 length = _baseTokensMap[trader].length;
        for (uint256 i; i < length; i++) {
            if (_baseTokensMap[trader][i] == baseToken) {
                // if the item to be removed is the last one, pop it directly
                // else, replace it with the last one and pop the last one
                if (i != length - 1) {
                    _baseTokensMap[trader][i] = _baseTokensMap[trader][length - 1];
                }
                _baseTokensMap[trader].pop();
                break;
            }
        }
    }

    function registerBaseToken(address trader, address baseToken) external onlyClearingHouse {
        address[] memory tokens = _baseTokensMap[trader];
        if (tokens.length == 0) {
            _baseTokensMap[trader].push(baseToken);
            return;
        }

        // if baseBalance == 0, token is not yet registered by any external function (ex: mint, burn, swap)
        if (getBase(trader, baseToken) == 0) {
            bool hit;
            for (uint256 i = 0; i < tokens.length; i++) {
                if (tokens[i] == baseToken) {
                    hit = true;
                    break;
                }
            }
            if (!hit) {
                // markets number exceeded
                uint8 maxMarketsPerAccount = ClearingHouseConfig(clearingHouseConfig).maxMarketsPerAccount();
                require(maxMarketsPerAccount == 0 || tokens.length < maxMarketsPerAccount, "AB_MNE");
                _baseTokensMap[trader].push(baseToken);
            }
        }
    }

    //
    // External
    //

    /// @dev this function is now only called by Vault.withdraw()
    function settle(address trader) external returns (int256) {
        // only vault
        require(_msgSender() == vault, "AB_OV");

        // the full process of a trader's withdrawal:
        // for loop of each order:
        //     call CH.removeLiquidity(baseToke, lowerTick, upperTick, 0)
        //         settle funding payment to owedRealizedPnl
        //         collect fee to owedRealizedPnl
        // call Vault.withdraw(token, amount)
        //     settle pnl to trader balance in Vault
        //     transfer amount to trader

        // make sure funding payments are always settled,
        // while fees are ok to let maker decides whether to collect using CH.removeLiquidity(0)
        for (uint256 i = 0; i < _baseTokensMap[trader].length; i++) {
            address baseToken = _baseTokensMap[trader][i];
            _settleFundingAndUpdateFundingGrowth(trader, baseToken);
        }

        int256 pnl = _owedRealizedPnlMap[trader];
        _owedRealizedPnlMap[trader] = 0;

        return pnl;
    }

    //
    // External View
    //

    function getOwedRealizedPnl(address trader) external view returns (int256) {
        return _owedRealizedPnlMap[trader];
    }

    function getFirstTradedTimestamp(address baseToken) external view returns (uint256) {
        return _firstTradedTimestampMap[baseToken];
    }

    function getLastUpdatedTickMap(address baseToken) external view returns (int24) {
        return _lastUpdatedTickMap[baseToken];
    }

    function hasOrder(address trader) external view returns (bool) {
        return OrderBook(orderBook).hasOrder(trader, _baseTokensMap[trader]);
    }

    function getOwedRealizedPnlWithPendingFundingPayment(address trader)
        external
        view
        returns (int256 owedRealizedPnl)
    {
        return _owedRealizedPnlMap[trader].sub(_getAllPendingFundingPayment(trader));
    }

    // TODO refactor with _getTotalBaseDebtValue and getTotalUnrealizedPnl
    function getTotalAbsPositionValue(address trader) external view returns (uint256) {
        address[] memory tokens = _baseTokensMap[trader];
        uint256 totalPositionValue;
        uint256 tokenLen = tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = tokens[i];
            // will not use negative value in this case
            uint256 positionValue = getPositionValue(trader, baseToken).abs();
            totalPositionValue = totalPositionValue.add(positionValue);
        }
        return totalPositionValue;
    }

    function getTotalDebtValue(address trader) external view returns (uint256) {
        int256 totalQuoteBalance;
        uint256 totalBaseDebtValue;
        uint256 tokenLen = _baseTokensMap[trader].length;

        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = _baseTokensMap[trader][i];
            int256 baseBalance = getBase(trader, baseToken);
            uint256 baseDebt = baseBalance > 0 ? 0 : (-baseBalance).toUint256();
            uint256 baseDebtValue = baseDebt.mul(_getIndexPrice(baseToken)).divBy10_18();
            // we can't calculate totalQuoteDebtValue until we have accumulated totalQuoteBalance
            int256 quoteBalance = getQuote(trader, baseToken);
            totalBaseDebtValue = totalBaseDebtValue.add(baseDebtValue);
            totalQuoteBalance = totalQuoteBalance.add(quoteBalance);
        }

        uint256 totalQuoteDebtValue = totalQuoteBalance > 0 ? 0 : (-totalQuoteBalance).toUint256();

        return totalQuoteDebtValue.add(totalBaseDebtValue);
    }

    function getTotalUnrealizedPnl(address trader) external view returns (int256) {
        int256 totalPositionValue;
        for (uint256 i = 0; i < _baseTokensMap[trader].length; i++) {
            address baseToken = _baseTokensMap[trader][i];
            totalPositionValue = totalPositionValue.add(getPositionValue(trader, baseToken));
        }

        return getNetQuoteBalance(trader).add(totalPositionValue);
    }

    //
    // PUBLIC
    //
    function getBase(address trader, address baseToken) public view returns (int256) {
        return _accountMarketMap[trader][baseToken].baseBalance;
    }

    function getQuote(address trader, address baseToken) public view returns (int256) {
        return _accountMarketMap[trader][baseToken].quoteBalance;
    }

    /// @return netQuoteBalance = quote.balance + totalQuoteInPools
    function getNetQuoteBalance(address trader) public view returns (int256) {
        uint256 tokenLen = _baseTokensMap[trader].length;
        int256 totalQuoteBalance;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = _baseTokensMap[trader][i];
            totalQuoteBalance = totalQuoteBalance.add(getQuote(trader, baseToken));
        }

        // owedFee is included
        uint256 totalQuoteInPools = OrderBook(orderBook).getTotalQuoteAmountInPools(trader, _baseTokensMap[trader]);
        int256 netQuoteBalance = totalQuoteBalance.add(totalQuoteInPools.toInt256());

        return netQuoteBalance.abs() < _DUST ? 0 : netQuoteBalance;
    }

    function getPositionSize(address trader, address baseToken) public view returns (int256) {
        // NOTE: when a token goes into UniswapV3 pool (addLiquidity or swap), there would be 1 wei rounding error
        // for instance, maker adds liquidity with 2 base (2000000000000000000),
        // the actual base amount in pool would be 1999999999999999999
        int256 positionSize =
            OrderBook(orderBook)
                .getTotalTokenAmountInPool(
                trader,
                baseToken,
                true // get base token amount
            )
                .toInt256()
                .add(getBase(trader, baseToken));
        return positionSize.abs() < _DUST ? 0 : positionSize;
    }

    /// @dev a negative returned value is only be used when calculating pnl
    /// @dev we use 15 mins twap to calc position value
    function getPositionValue(address trader, address baseToken) public view returns (int256) {
        int256 positionSize = getPositionSize(trader, baseToken);
        if (positionSize == 0) return 0;

        uint256 indexTwap = IIndexPrice(baseToken).getIndexPrice(_getTwapInterval());

        // both positionSize & indexTwap are in 10^18 already
        return positionSize.mul(indexTwap.toInt256()).divBy10_18();
    }

    /// @return fundingPayment the funding payment of a market, including liquidity & availableAndDebt coefficients
    function getPendingFundingPayment(address trader, address baseToken) public view returns (int256) {
        (Funding.Growth memory fundingGrowthGlobal, , ) = _getFundingGrowthGlobalAndTwaps(baseToken);
        return _getPendingFundingPayment(trader, baseToken, fundingGrowthGlobal);
    }

    //
    // INTERNAL
    //
    function _settleFundingAndUpdateFundingGrowth(address trader, address baseToken)
        internal
        returns (Funding.Growth memory fundingGrowthGlobal)
    {
        uint256 markTwap;
        uint256 indexTwap;
        (fundingGrowthGlobal, markTwap, indexTwap) = _getFundingGrowthGlobalAndTwaps(baseToken);

        // pass fundingGrowthGlobal in for states mutation
        int256 liquidityCoefficientInFundingPayment =
            OrderBook(orderBook).updateFundingGrowthAndLiquidityCoefficientInFundingPayment(
                trader,
                baseToken,
                fundingGrowthGlobal
            );

        int256 fundingPayment =
            _accountMarketMap[trader][baseToken].updateFundingGrowthAngFundingPayment(
                liquidityCoefficientInFundingPayment,
                fundingGrowthGlobal.twPremiumX96
            );

        if (fundingPayment != 0) {
            _owedRealizedPnlMap[trader] = _owedRealizedPnlMap[trader].sub(fundingPayment);
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

    //
    // Internal View
    //

    /// @dev this function calculates the up-to-date globalFundingGrowth and twaps and pass them out
    /// @return fundingGrowthGlobal the up-to-date globalFundingGrowth
    /// @return markTwap only for _settleFundingAndUpdateFundingGrowth()
    /// @return indexTwap only for _settleFundingAndUpdateFundingGrowth()
    function _getFundingGrowthGlobalAndTwaps(address baseToken)
        internal
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
        return ClearingHouseConfig(clearingHouseConfig).twapInterval();
    }

    /// @return fundingPayment the funding payment of all markets of a trader
    function _getAllPendingFundingPayment(address trader) internal view returns (int256 fundingPayment) {
        for (uint256 i = 0; i < _baseTokensMap[trader].length; i++) {
            address baseToken = _baseTokensMap[trader][i];
            fundingPayment = fundingPayment.add(getPendingFundingPayment(trader, baseToken));
        }
    }
}
