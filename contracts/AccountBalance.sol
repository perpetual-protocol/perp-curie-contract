// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { IExchange } from "./interface/IExchange.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { IOrderBook } from "./interface/IOrderBook.sol";
import { IClearingHouseConfigState } from "./interface/IClearingHouseConfigState.sol";
import { AccountBalanceStorageV1, AccountMarket } from "./storage/AccountBalanceStorage.sol";
import { BlockContext } from "./base/BlockContext.sol";
import { IAccountBalance } from "./interface/IAccountBalance.sol";

contract AccountBalance is IAccountBalance, BlockContext, AccountBalanceStorageV1 {
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
    // EXTERNAL NON-VIEW
    //

    function initialize(address clearingHouseConfigArg, address exchangeArg) external initializer {
        // IClearingHouseConfig address is not contract
        require(clearingHouseConfigArg.isContract(), "AB_CHCNC");
        // Exchange is not contract
        require(exchangeArg.isContract(), "AB_EXNC");

        address orderBookArg = IExchange(exchangeArg).orderBook();
        // IOrderBook is not contarct
        require(orderBookArg.isContract(), "AB_OBNC");

        __ClearingHouseCallee_init();

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
        int256 owedRealizedPnl
    ) external override {
        // AB_O_EX|CH: only exchange or CH
        require(_msgSender() == exchange || _msgSender() == clearingHouse, "AB_O_EX|CH");
        AccountMarket.Info storage accountInfo = _accountMarketMap[trader][baseToken];
        accountInfo.baseBalance = accountInfo.baseBalance.add(base);
        accountInfo.quoteBalance = accountInfo.quoteBalance.add(quote);
        _owedRealizedPnlMap[trader] = _owedRealizedPnlMap[trader].add(owedRealizedPnl);
    }

    function addOwedRealizedPnl(address trader, int256 delta) external override {
        // AB_O_EX|CH: only exchange or CH
        require(_msgSender() == exchange || _msgSender() == clearingHouse, "AB_O_EX|CH");

        _owedRealizedPnlMap[trader] = _owedRealizedPnlMap[trader].add(delta);
    }

    function settleQuoteToPnl(
        address trader,
        address baseToken,
        int256 amount
    ) external override {
        // AB_OEX: only exchange
        require(_msgSender() == exchange, "AB_OEX");
        AccountMarket.Info storage accountInfo = _accountMarketMap[trader][baseToken];
        accountInfo.quoteBalance = accountInfo.quoteBalance.sub(amount);
        _owedRealizedPnlMap[trader] = _owedRealizedPnlMap[trader].add(amount);
    }

    function updateTwPremiumGrowthGlobal(
        address trader,
        address baseToken,
        int256 lastTwPremiumGrowthGlobalX96
    ) external override {
        // AB_OEX: only exchange
        require(_msgSender() == exchange, "AB_OEX");
        _accountMarketMap[trader][baseToken].lastTwPremiumGrowthGlobalX96 = lastTwPremiumGrowthGlobalX96;
    }

    /// @dev this function is expensive
    function deregisterBaseToken(address trader, address baseToken) external override onlyClearingHouse {
        if (getBase(trader, baseToken).abs() >= _DUST || getQuote(trader, baseToken).abs() >= _DUST) {
            return;
        }

        uint256 baseInPool = IOrderBook(orderBook).getTotalTokenAmountInPool(trader, baseToken, true);
        uint256 quoteInPool = IOrderBook(orderBook).getTotalTokenAmountInPool(trader, baseToken, false);
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

    function registerBaseToken(address trader, address baseToken) external override onlyClearingHouse {
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
                uint8 maxMarketsPerAccount = IClearingHouseConfigState(clearingHouseConfig).maxMarketsPerAccount();
                require(maxMarketsPerAccount == 0 || tokens.length < maxMarketsPerAccount, "AB_MNE");
                _baseTokensMap[trader].push(baseToken);
            }
        }
    }

    /// @dev this function is now only called by Vault.withdraw()
    function settle(address trader) external override returns (int256) {
        // only vault
        require(_msgSender() == vault, "AB_OV");
        int256 owedRealizedPnl = _owedRealizedPnlMap[trader];
        _owedRealizedPnlMap[trader] = 0;

        return owedRealizedPnl;
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc IAccountBalance
    function getBaseTokens(address trader) external view override returns (address[] memory) {
        return _baseTokensMap[trader];
    }

    /// @inheritdoc IAccountBalance
    function hasOrder(address trader) external view override returns (bool) {
        return IOrderBook(orderBook).hasOrder(trader, _baseTokensMap[trader]);
    }

    /// @inheritdoc IAccountBalance
    /// @dev get margin requirement for determining liquidation.
    /// Different purpose from `_getTotalMarginRequirement` which is for free collateral calculation.
    function getLiquidateMarginRequirement(address trader) external view override returns (int256) {
        return
            _getTotalAbsPositionValue(trader)
                .mulRatio(IClearingHouseConfigState(clearingHouseConfig).mmRatio())
                .toInt256();
    }

    /// @inheritdoc IAccountBalance
    function getTotalDebtValue(address trader) external view override returns (uint256) {
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

    /// @inheritdoc IAccountBalance
    function getOwedAndUnrealizedPnl(address trader) external view override returns (int256, int256) {
        int256 owedRealizedPnl = _owedRealizedPnlMap[trader];

        // unrealized Pnl
        int256 totalPositionValue;
        for (uint256 i = 0; i < _baseTokensMap[trader].length; i++) {
            address baseToken = _baseTokensMap[trader][i];
            totalPositionValue = totalPositionValue.add(getPositionValue(trader, baseToken));
        }
        int256 unrealizedPnl = getNetQuoteBalance(trader).add(totalPositionValue);

        return (owedRealizedPnl, unrealizedPnl);
    }

    /// @inheritdoc IAccountBalance
    function getAccountInfo(address trader, address baseToken)
        external
        view
        override
        returns (AccountMarket.Info memory)
    {
        return _accountMarketMap[trader][baseToken];
    }

    /// @inheritdoc IAccountBalance
    function getBase(address trader, address baseToken) public view override returns (int256) {
        return _accountMarketMap[trader][baseToken].baseBalance;
    }

    /// @inheritdoc IAccountBalance
    function getQuote(address trader, address baseToken) public view override returns (int256) {
        return _accountMarketMap[trader][baseToken].quoteBalance;
    }

    /// @inheritdoc IAccountBalance
    function getNetQuoteBalance(address trader) public view override returns (int256) {
        uint256 tokenLen = _baseTokensMap[trader].length;
        int256 totalQuoteBalance;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = _baseTokensMap[trader][i];
            totalQuoteBalance = totalQuoteBalance.add(getQuote(trader, baseToken));
        }

        // owedFee is included
        uint256 totalQuoteInPools = IOrderBook(orderBook).getTotalQuoteAmountInPools(trader, _baseTokensMap[trader]);
        int256 netQuoteBalance = totalQuoteBalance.add(totalQuoteInPools.toInt256());

        return netQuoteBalance.abs() < _DUST ? 0 : netQuoteBalance;
    }

    /// @inheritdoc IAccountBalance
    function getPositionSize(address trader, address baseToken) public view override returns (int256) {
        // NOTE: when a token goes into UniswapV3 pool (addLiquidity or swap), there would be 1 wei rounding error
        // for instance, maker adds liquidity with 2 base (2000000000000000000),
        // the actual base amount in pool would be 1999999999999999999
        int256 positionSize =
            IOrderBook(orderBook)
                .getTotalTokenAmountInPool(
                trader,
                baseToken,
                true // get base token amount
            )
                .toInt256()
                .add(getBase(trader, baseToken));
        return positionSize.abs() < _DUST ? 0 : positionSize;
    }

    /// @inheritdoc IAccountBalance
    function getPositionValue(address trader, address baseToken) public view override returns (int256) {
        int256 positionSize = getPositionSize(trader, baseToken);
        if (positionSize == 0) return 0;

        uint256 indexTwap = _getIndexPrice(baseToken);
        // both positionSize & indexTwap are in 10^18 already
        return positionSize.mul(indexTwap.toInt256()).divBy10_18();
    }

    //
    // INTERNAL VIEW
    //

    function _getIndexPrice(address baseToken) internal view returns (uint256) {
        return IIndexPrice(baseToken).getIndexPrice(IClearingHouseConfigState(clearingHouseConfig).twapInterval());
    }

    function _getTotalAbsPositionValue(address trader) internal view returns (uint256) {
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
}
