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
    // STATE
    //

    // 10 wei
    uint256 internal constant _DUST = 10;

    address public clearingHouseConfig;
    address public exchange;
    address public orderBook;
    address public vault;

    // trader => owedRealizedPnl
    mapping(address => int256) internal _owedRealizedPnlMap;

    // trader => baseTokens
    // base token registry of each trader
    mapping(address => address[]) internal _baseTokensMap;

    // first key: trader, second key: baseToken
    mapping(address => mapping(address => AccountMarket.Info)) internal _accountMarketMap;

    //
    // EXTERNAL NON-VIEW
    //

    function initialize(
        address clearingHouseConfigArg,
        address marketRegistryArg,
        address exchangeArg
    ) external initializer {
        // ClearingHouseConfig address is not contract
        require(clearingHouseConfigArg.isContract(), "AB_CHCNC");
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

    function setVault(address vaultArg) external onlyOwner {
        // vault address is not contract
        require(vaultArg.isContract(), "AB_VNC");
        vault = vaultArg;
    }

    function addBalance(
        address trader,
        address baseToken,
        int256 base,
        int256 quote,
        int256 owedRealizedPnl /*onlyClearingHouse*/
    ) external {
        AccountMarket.Info storage accountInfo = _accountMarketMap[trader][baseToken];
        accountInfo.baseBalance = accountInfo.baseBalance.add(base);
        accountInfo.quoteBalance = accountInfo.quoteBalance.add(quote);
        _owedRealizedPnlMap[trader] = _owedRealizedPnlMap[trader].add(owedRealizedPnl);
    }

    function settleQuoteToPnl(
        address trader,
        address baseToken,
        int256 amount /*onlyClearingHouse*/
    ) external {
        AccountMarket.Info storage accountInfo = _accountMarketMap[trader][baseToken];
        accountInfo.quoteBalance = accountInfo.quoteBalance.sub(amount);
        _owedRealizedPnlMap[trader] = _owedRealizedPnlMap[trader].add(amount);
    }

    function addOwedRealizedPnl(address trader, int256 delta) external onlyClearingHouse {
        _owedRealizedPnlMap[trader] = _owedRealizedPnlMap[trader].add(delta);
    }

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

    /// @dev this function is now only called by Vault.withdraw()
    function settle(address trader) external returns (int256 pnl) {
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

        pnl = _owedRealizedPnlMap[trader];
        _owedRealizedPnlMap[trader] = 0;

        return pnl;
    }

    //
    // EXTERNAL VIEW
    //

    function getBaseTokens(address trader) external view returns (address[] memory) {
        return _baseTokensMap[trader];
    }

    function getOwedRealizedPnl(address trader) external view returns (int256) {
        return _owedRealizedPnlMap[trader];
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
    // PUBLIC VIEW
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

    /// @return the pending funding payment of a trader in one market
    function getPendingFundingPayment(address trader, address baseToken) public view returns (int256) {
        return _getPendingFundingPayment(trader, baseToken);
    }

    //
    // Internal VIEW
    //

    /// @dev this function should be called at the beginning of every high-level function, such as openPosition()
    /// @return fundingGrowthGlobal the up-to-date globalFundingGrowth, usually used for later calculations
    function _settleFundingAndUpdateFundingGrowth(address trader, address baseToken)
        internal
        returns (Funding.Growth memory)
    {
        (Funding.Growth memory fundingGrowthGlobal, int256 fundingPayment) =
            Exchange(exchange).settleFundingAndUpdateFundingGrowth(
                trader,
                baseToken,
                _accountMarketMap[trader][baseToken].baseBalance,
                _accountMarketMap[trader][baseToken].lastTwPremiumGrowthGlobalX96
            );
        _accountMarketMap[trader][baseToken].lastTwPremiumGrowthGlobalX96 = fundingGrowthGlobal.twPremiumX96;

        if (fundingPayment != 0) {
            _owedRealizedPnlMap[trader] = _owedRealizedPnlMap[trader].sub(fundingPayment);
        }

        return fundingGrowthGlobal;
    }

    function _getPendingFundingPayment(address trader, address baseToken) internal view returns (int256) {
        return
            Exchange(exchange).getPendingFundingPayment(
                trader,
                baseToken,
                _accountMarketMap[trader][baseToken].baseBalance,
                _accountMarketMap[trader][baseToken].lastTwPremiumGrowthGlobalX96
            );
    }

    function _getIndexPrice(address baseToken) internal view returns (uint256) {
        return IIndexPrice(baseToken).getIndexPrice(_getTwapInterval());
    }

    function _getTwapInterval() internal view returns (uint32) {
        return ClearingHouseConfig(clearingHouseConfig).twapInterval();
    }

    /// @return pendingFundingPayment the pending funding payment of a trader in all markets
    function _getAllPendingFundingPayment(address trader) internal view returns (int256 pendingFundingPayment) {
        for (uint256 i = 0; i < _baseTokensMap[trader].length; i++) {
            address baseToken = _baseTokensMap[trader][i];
            pendingFundingPayment = pendingFundingPayment.add(_getPendingFundingPayment(trader, baseToken));
        }
        return pendingFundingPayment;
    }
}
