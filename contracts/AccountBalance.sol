// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { ClearingHouseCallee } from "./base/ClearingHouseCallee.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { IExchange } from "./interface/IExchange.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { IOrderBook } from "./interface/IOrderBook.sol";
import { IClearingHouseConfig } from "./interface/IClearingHouseConfig.sol";
import { AccountBalanceStorageV1, AccountMarket } from "./storage/AccountBalanceStorage.sol";
import { BlockContext } from "./base/BlockContext.sol";
import { IAccountBalance } from "./interface/IAccountBalance.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract AccountBalance is IAccountBalance, BlockContext, ClearingHouseCallee, AccountBalanceStorageV1 {
    using AddressUpgradeable for address;
    using SafeMathUpgradeable for uint256;
    using SignedSafeMathUpgradeable for int256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;
    using PerpMath for uint256;
    using PerpMath for int256;
    using PerpMath for uint160;
    using AccountMarket for AccountMarket.Info;

    // CONSTANT
    uint256 internal constant _DUST = 10 wei;

    //
    // MODIFIER
    //
    modifier onlyExchange() {
        // only Exchange
        require(_msgSender() == _exchange, "AB_OEX");
        _;
    }

    modifier onlyExchangeOrClearingHouse() {
        // only Exchange or ClearingHouse
        require(_msgSender() == _exchange || _msgSender() == _clearingHouse, "AB_O_EX|CH");
        _;
    }

    //
    // EXTERNAL NON-VIEW
    //

    function initialize(address clearingHouseConfigArg, address exchangeArg) external initializer {
        // IClearingHouseConfig address is not contract
        require(clearingHouseConfigArg.isContract(), "AB_CHCNC");
        // Exchange is not contract
        require(exchangeArg.isContract(), "AB_EXNC");

        address orderBookArg = IExchange(exchangeArg).getOrderBook();
        // IOrderBook is not contract
        require(orderBookArg.isContract(), "AB_OBNC");

        __ClearingHouseCallee_init();

        _clearingHouseConfig = clearingHouseConfigArg;
        _exchange = exchangeArg;
        _orderBook = orderBookArg;
    }

    function setVault(address vaultArg) external onlyOwner {
        // vault address is not contract
        require(vaultArg.isContract(), "AB_VNC");
        _vault = vaultArg;
        emit VaultChanged(vaultArg);
    }

    function settleBalanceAndDeregister(
        address maker,
        address baseToken,
        int256 base,
        int256 quote,
        int256 deltaTakerBase,
        int256 deltaTakerQuote,
        int256 fee
    ) external override onlyClearingHouse {
        _addBalance(maker, baseToken, base, quote, fee);
        _modifyTakerBalance(maker, baseToken, deltaTakerBase, deltaTakerQuote);
        _settleQuoteBalance(maker, baseToken);
        _deregisterBaseToken(maker, baseToken);
    }

    function addBalance(
        address trader,
        address baseToken,
        int256 base,
        int256 quote,
        int256 owedRealizedPnl
    ) external override onlyExchangeOrClearingHouse {
        _addBalance(trader, baseToken, base, quote, owedRealizedPnl);
    }

    function addTakerBalance(
        address trader,
        address baseToken,
        int256 base,
        int256 quote,
        int256 owedRealizedPnl
    ) external override onlyExchangeOrClearingHouse {
        _modifyTakerBalance(trader, baseToken, base, quote);
        _addOwedRealizedPnl(trader, owedRealizedPnl);
    }

    function addBothBalances(
        address trader,
        address baseToken,
        int256 base,
        int256 quote,
        int256 owedRealizedPnl
    ) external override onlyExchangeOrClearingHouse {
        _addBalance(trader, baseToken, base, quote, owedRealizedPnl);
        _modifyTakerBalance(trader, baseToken, base, quote);
    }

    function addOwedRealizedPnl(address trader, int256 delta) external override onlyExchangeOrClearingHouse {
        _addOwedRealizedPnl(trader, delta);
    }

    function settleQuoteToPnl(
        address trader,
        address baseToken,
        int256 amount
    ) external override onlyExchange {
        _settleQuoteToPnl(trader, baseToken, amount);
    }

    function updateTwPremiumGrowthGlobal(
        address trader,
        address baseToken,
        int256 lastTwPremiumGrowthGlobalX96
    ) external override onlyExchange {
        _accountMarketMap[trader][baseToken].lastTwPremiumGrowthGlobalX96 = lastTwPremiumGrowthGlobalX96;
    }

    function deregisterBaseToken(address trader, address baseToken) external override onlyClearingHouse {
        _deregisterBaseToken(trader, baseToken);
    }

    function registerBaseToken(address trader, address baseToken) external override onlyClearingHouse {
        address[] memory tokens = _baseTokensMap[trader];
        if (tokens.length == 0) {
            _baseTokensMap[trader].push(baseToken);
            return;
        }

        // only register if there is no taker's position nor any openOrder (whether in base or quote token)
        if (getBase(trader, baseToken) == 0 && IOrderBook(_orderBook).getOpenOrderIds(trader, baseToken).length == 0) {
            for (uint256 i = 0; i < tokens.length; i++) {
                if (tokens[i] == baseToken) {
                    return;
                }
            }
            // AB_MNE: markets number exceeds
            require(tokens.length < IClearingHouseConfig(_clearingHouseConfig).getMaxMarketsPerAccount(), "AB_MNE");
            _baseTokensMap[trader].push(baseToken);
        }
    }

    /// @dev this function is only called by Vault.withdraw()
    function settleOwedRealizedPnl(address trader) external override returns (int256) {
        // only vault
        require(_msgSender() == _vault, "AB_OV");
        int256 owedRealizedPnl = _owedRealizedPnlMap[trader];
        _owedRealizedPnlMap[trader] = 0;

        return owedRealizedPnl;
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc IAccountBalance
    function getClearingHouseConfig() external view override returns (address) {
        return _clearingHouseConfig;
    }

    /// @inheritdoc IAccountBalance
    function getExchange() external view override returns (address) {
        return _exchange;
    }

    /// @inheritdoc IAccountBalance
    function getOrderBook() external view override returns (address) {
        return _orderBook;
    }

    /// @inheritdoc IAccountBalance
    function getVault() external view override returns (address) {
        return _vault;
    }

    /// @inheritdoc IAccountBalance
    function getBaseTokens(address trader) external view override returns (address[] memory) {
        return _baseTokensMap[trader];
    }

    /// @inheritdoc IAccountBalance
    function hasOrder(address trader) external view override returns (bool) {
        return IOrderBook(_orderBook).hasOrder(trader, _baseTokensMap[trader]);
    }

    /// @inheritdoc IAccountBalance
    /// @dev this is different from Vault._getTotalMarginRequirement(), which is for freeCollateral calculation
    /// @return int instead of uint, as it is compared with ClearingHouse.getAccountValue(), which is also an int
    function getMarginRequirementForLiquidation(address trader) external view override returns (int256) {
        return
            getTotalAbsPositionValue(trader)
                .mulRatio(IClearingHouseConfig(_clearingHouseConfig).getMmRatio())
                .toInt256();
    }

    /// @inheritdoc IAccountBalance
    function getTotalDebtValue(address trader) external view override returns (uint256) {
        int256 totalQuoteBalance;
        int256 totalBaseDebtValue;
        uint256 tokenLen = _baseTokensMap[trader].length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = _baseTokensMap[trader][i];
            AccountMarket.Info memory info = _accountMarketMap[trader][baseToken];
            int256 baseDebtValue =
                info.baseBalance >= 0 ? 0 : info.baseBalance.mul(_getIndexPrice(baseToken).toInt256()).divBy10_18();
            totalBaseDebtValue = totalBaseDebtValue.add(baseDebtValue);

            // we can't calculate totalQuoteDebtValue until we have totalQuoteBalance
            totalQuoteBalance = totalQuoteBalance.add(info.quoteBalance);
        }
        int256 totalQuoteDebtValue = totalQuoteBalance >= 0 ? 0 : totalQuoteBalance;

        // both values are negative due to the above condition checks
        return totalQuoteDebtValue.add(totalBaseDebtValue).abs();
    }

    /// @inheritdoc IAccountBalance
    /// @return owedRealizedPnl the pnl realized already but stored temporarily in AccountBalance
    /// @return unrealizedPnl the pnl not yet realized
    function getOwedAndUnrealizedPnl(address trader) external view override returns (int256, int256) {
        int256 totalPositionValue;
        uint256 tokenLen = _baseTokensMap[trader].length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = _baseTokensMap[trader][i];
            totalPositionValue = totalPositionValue.add(getPositionValue(trader, baseToken));
        }
        int256 unrealizedPnl = getNetQuoteBalance(trader).add(totalPositionValue);

        return (_owedRealizedPnlMap[trader], unrealizedPnl);
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
        int256 totalQuoteBalance;
        uint256 tokenLen = _baseTokensMap[trader].length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = _baseTokensMap[trader][i];
            totalQuoteBalance = totalQuoteBalance.add(getQuote(trader, baseToken));
        }

        // owedFee is included
        uint256 totalQuoteInPools = IOrderBook(_orderBook).getTotalQuoteAmountInPools(trader, _baseTokensMap[trader]);
        int256 netQuoteBalance = totalQuoteBalance.add(totalQuoteInPools.toInt256());

        return netQuoteBalance.abs() < _DUST ? 0 : netQuoteBalance;
    }

    /// @inheritdoc IAccountBalance
    function getPositionSize(address trader, address baseToken) public view override returns (int256) {
        // NOTE: when a token goes into UniswapV3 pool (addLiquidity or swap), there would be 1 wei rounding error
        // for instance, maker adds liquidity with 2 base (2000000000000000000),
        // the actual base amount in pool would be 1999999999999999999
        int256 positionSize =
            IOrderBook(_orderBook)
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
    function getTakerPositionSize(address trader, address baseToken) external view override returns (int256) {
        int256 positionSize = _accountMarketMap[trader][baseToken].takerBaseBalance;
        return positionSize.abs() < _DUST ? 0 : positionSize;
    }

    /// @inheritdoc IAccountBalance
    function getPositionValue(address trader, address baseToken) public view override returns (int256) {
        int256 positionSize = getPositionSize(trader, baseToken);
        if (positionSize == 0) return 0;

        uint256 indexTwap = _getIndexPrice(baseToken);
        // both positionSize & indexTwap are in 10^18 already
        // overflow inspection:
        // only overflow when position value in USD(18 decimals) > 2^255 / 10^18
        return positionSize.mul(indexTwap.toInt256()).divBy10_18();
    }

    /// @inheritdoc IAccountBalance
    function getTotalAbsPositionValue(address trader) public view override returns (uint256) {
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

    //
    // INTERNAL NON-VIEW
    //

    function _addBalance(
        address trader,
        address baseToken,
        int256 base,
        int256 quote,
        int256 owedRealizedPnl
    ) internal {
        AccountMarket.Info storage accountInfo = _accountMarketMap[trader][baseToken];
        accountInfo.baseBalance = accountInfo.baseBalance.add(base);
        accountInfo.quoteBalance = accountInfo.quoteBalance.add(quote);
        _addOwedRealizedPnl(trader, owedRealizedPnl);
    }

    function _modifyTakerBalance(
        address trader,
        address baseToken,
        int256 deltaBase,
        int256 deltaQuote
    ) internal {
        AccountMarket.Info storage accountInfo = _accountMarketMap[trader][baseToken];
        accountInfo.takerBaseBalance = accountInfo.takerBaseBalance.add(deltaBase);
        accountInfo.takerQuoteBalance = accountInfo.takerQuoteBalance.add(deltaQuote);
        emit TakerBalancesChanged(trader, baseToken, deltaBase, deltaQuote);
    }

    function _settleQuoteBalance(address trader, address baseToken) internal {
        if (
            getPositionSize(trader, baseToken) == 0 &&
            IOrderBook(_orderBook).getOpenOrderIds(trader, baseToken).length == 0
        ) {
            _settleQuoteToPnl(trader, baseToken, getQuote(trader, baseToken));
        }
    }

    function _settleQuoteToPnl(
        address trader,
        address baseToken,
        int256 amount
    ) internal {
        AccountMarket.Info storage accountInfo = _accountMarketMap[trader][baseToken];
        accountInfo.quoteBalance = accountInfo.quoteBalance.sub(amount);
        _addOwedRealizedPnl(trader, amount);
    }

    function _addOwedRealizedPnl(address trader, int256 delta) internal {
        if (delta != 0) {
            _owedRealizedPnlMap[trader] = _owedRealizedPnlMap[trader].add(delta);
            emit PnlRealized(trader, delta);
        }
    }

    /// @dev this function is expensive
    function _deregisterBaseToken(address trader, address baseToken) internal {
        AccountMarket.Info memory info = _accountMarketMap[trader][baseToken];
        if (info.baseBalance.abs() >= _DUST || info.quoteBalance.abs() >= _DUST) {
            return;
        }

        uint256 baseInPool = IOrderBook(_orderBook).getTotalTokenAmountInPool(trader, baseToken, true);
        if (baseInPool > 0) {
            return;
        }

        uint256 quoteInPool = IOrderBook(_orderBook).getTotalTokenAmountInPool(trader, baseToken, false);
        if (quoteInPool > 0) {
            return;
        }

        delete _accountMarketMap[trader][baseToken];

        uint256 tokenLen = _baseTokensMap[trader].length;
        for (uint256 i; i < tokenLen; i++) {
            if (_baseTokensMap[trader][i] == baseToken) {
                // if the item to be removed is the last one, pop it directly
                // else, replace it with the last one and pop the last one
                if (i != tokenLen - 1) {
                    _baseTokensMap[trader][i] = _baseTokensMap[trader][tokenLen - 1];
                }
                _baseTokensMap[trader].pop();
                break;
            }
        }
    }

    //
    // INTERNAL VIEW
    //

    function _getIndexPrice(address baseToken) internal view returns (uint256) {
        return IIndexPrice(baseToken).getIndexPrice(IClearingHouseConfig(_clearingHouseConfig).getTwapInterval());
    }
}
