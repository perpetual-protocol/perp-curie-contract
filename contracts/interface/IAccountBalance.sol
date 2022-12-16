// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AccountMarket } from "../lib/AccountMarket.sol";

interface IAccountBalance {
    /// @param vault The address of the vault contract
    event VaultChanged(address indexed vault);

    /// @dev Emit whenever a trader's `owedRealizedPnl` is updated
    /// @param trader The address of the trader
    /// @param amount The amount changed
    event PnlRealized(address indexed trader, int256 amount);

    /// @notice Modify trader account balance
    /// @dev Only used by `ClearingHouse` contract
    /// @param trader The address of the trader
    /// @param baseToken The address of the baseToken
    /// @param base Modified amount of base
    /// @param quote Modified amount of quote
    /// @return takerPositionSize Taker position size after modified
    /// @return takerOpenNotional Taker open notional after modified
    function modifyTakerBalance(
        address trader,
        address baseToken,
        int256 base,
        int256 quote
    ) external returns (int256 takerPositionSize, int256 takerOpenNotional);

    /// @notice Modify trader owedRealizedPnl
    /// @dev Only used by `ClearingHouse` contract
    /// @param trader The address of the trader
    /// @param amount Modified amount of owedRealizedPnl
    function modifyOwedRealizedPnl(address trader, int256 amount) external;

    /// @notice Settle owedRealizedPnl
    /// @dev Only used by `Vault.withdraw()`
    /// @param trader The address of the trader
    /// @return pnl Settled owedRealizedPnl
    function settleOwedRealizedPnl(address trader) external returns (int256 pnl);

    /// @notice Modify trader owedRealizedPnl
    /// @dev Only used by `ClearingHouse` contract
    /// @param trader The address of the trader
    /// @param baseToken The address of the baseToken
    /// @param amount Settled quote amount
    function settleQuoteToOwedRealizedPnl(
        address trader,
        address baseToken,
        int256 amount
    ) external;

    /// @notice Settle account balance and deregister base token
    /// @dev Only used by `ClearingHouse` contract
    /// @param trader The address of the trader
    /// @param baseToken The address of the baseToken
    /// @param takerBase Modified amount of taker base
    /// @param takerQuote Modified amount of taker quote
    /// @param realizedPnl Amount of pnl realized
    /// @param makerFee Amount of maker fee collected from pool
    function settleBalanceAndDeregister(
        address trader,
        address baseToken,
        int256 takerBase,
        int256 takerQuote,
        int256 realizedPnl,
        int256 makerFee
    ) external;

    /// @notice Every time a trader's position value is checked, the base token list of this trader will be traversed;
    /// thus, this list should be kept as short as possible
    /// @dev Only used by `ClearingHouse` contract
    /// @param trader The address of the trader
    /// @param baseToken The address of the trader's base token
    function registerBaseToken(address trader, address baseToken) external;

    /// @notice Deregister baseToken from trader accountInfo
    /// @dev Only used by `ClearingHouse` contract, this function is expensive, due to for loop
    /// @param trader The address of the trader
    /// @param baseToken The address of the trader's base token
    function deregisterBaseToken(address trader, address baseToken) external;

    /// @notice Update trader Twap premium info
    /// @dev Only used by `ClearingHouse` contract
    /// @param trader The address of trader
    /// @param baseToken The address of baseToken
    /// @param lastTwPremiumGrowthGlobalX96 The last Twap Premium
    function updateTwPremiumGrowthGlobal(
        address trader,
        address baseToken,
        int256 lastTwPremiumGrowthGlobalX96
    ) external;

    /// @notice Settle trader's PnL in closed market
    /// @dev Only used by `ClearingHouse`
    /// @param trader The address of the trader
    /// @param baseToken The address of the trader's base token
    /// @return positionNotional Taker's position notional settled with closed price
    /// @return openNotional Taker's open notional
    /// @return realizedPnl Settled realized pnl
    /// @return closedPrice The closed price of the closed market
    function settlePositionInClosedMarket(address trader, address baseToken)
        external
        returns (
            int256 positionNotional,
            int256 openNotional,
            int256 realizedPnl,
            uint256 closedPrice
        );

    /// @notice Get `ClearingHouseConfig` address
    /// @return clearingHouseConfig The address of ClearingHouseConfig
    function getClearingHouseConfig() external view returns (address clearingHouseConfig);

    /// @notice Get `OrderBook` address
    /// @return orderBook The address of OrderBook
    function getOrderBook() external view returns (address orderBook);

    /// @notice Get `Vault` address
    /// @return vault The address of Vault
    function getVault() external view returns (address vault);

    /// @notice Get trader registered baseTokens
    /// @param trader The address of trader
    /// @return baseTokens The array of baseToken address
    function getBaseTokens(address trader) external view returns (address[] memory baseTokens);

    /// @notice Get trader account info
    /// @param trader The address of trader
    /// @param baseToken The address of baseToken
    /// @return traderAccountInfo The baseToken account info of trader
    function getAccountInfo(address trader, address baseToken)
        external
        view
        returns (AccountMarket.Info memory traderAccountInfo);

    /// @notice Get taker cost of trader's baseToken
    /// @param trader The address of trader
    /// @param baseToken The address of baseToken
    /// @return openNotional The taker cost of trader's baseToken
    function getTakerOpenNotional(address trader, address baseToken) external view returns (int256 openNotional);

    /// @notice Get total cost of trader's baseToken
    /// @param trader The address of trader
    /// @param baseToken The address of baseToken
    /// @return totalOpenNotional the amount of quote token paid for a position when opening
    function getTotalOpenNotional(address trader, address baseToken) external view returns (int256 totalOpenNotional);

    /// @notice Get total debt value of trader
    /// @param trader The address of trader
    /// @dev Total debt value will relate to `Vault.getFreeCollateral()`
    /// @return totalDebtValue The debt value of trader
    function getTotalDebtValue(address trader) external view returns (uint256 totalDebtValue);

    /// @notice Get margin requirement to check whether trader will be able to liquidate
    /// @dev This is different from `Vault._getTotalMarginRequirement()`, which is for freeCollateral calculation
    /// @param trader The address of trader
    /// @return marginRequirementForLiquidation It is compared with `ClearingHouse.getAccountValue` which is also an int
    function getMarginRequirementForLiquidation(address trader)
        external
        view
        returns (int256 marginRequirementForLiquidation);

    /// @notice Get owedRealizedPnl, unrealizedPnl and pending fee
    /// @param trader The address of trader
    /// @return owedRealizedPnl the pnl realized already but stored temporarily in AccountBalance
    /// @return unrealizedPnl the pnl not yet realized
    /// @return pendingFee the pending fee of maker earned
    function getPnlAndPendingFee(address trader)
        external
        view
        returns (
            int256 owedRealizedPnl,
            int256 unrealizedPnl,
            uint256 pendingFee
        );

    /// @notice Check trader has open order in open/closed market.
    /// @param trader The address of trader
    /// @return True of false
    function hasOrder(address trader) external view returns (bool);

    /// @notice Get trader base amount
    /// @dev `base amount = takerPositionSize - orderBaseDebt`
    /// @param trader The address of trader
    /// @param baseToken The address of baseToken
    /// @return baseAmount The base amount of trader's baseToken market
    function getBase(address trader, address baseToken) external view returns (int256 baseAmount);

    /// @notice Get trader quote amount
    /// @dev `quote amount = takerOpenNotional - orderQuoteDebt`
    /// @param trader The address of trader
    /// @param baseToken The address of baseToken
    /// @return quoteAmount The quote amount of trader's baseToken market
    function getQuote(address trader, address baseToken) external view returns (int256 quoteAmount);

    /// @notice Get taker position size of trader's baseToken market
    /// @dev This will only has taker position, can get maker impermanent position through `getTotalPositionSize`
    /// @param trader The address of trader
    /// @param baseToken The address of baseToken
    /// @return takerPositionSize The taker position size of trader's baseToken market
    function getTakerPositionSize(address trader, address baseToken) external view returns (int256 takerPositionSize);

    /// @notice Get total position size of trader's baseToken market
    /// @dev `total position size = taker position size + maker impermanent position size`
    /// @param trader The address of trader
    /// @param baseToken The address of baseToken
    /// @return totalPositionSize The total position size of trader's baseToken market
    function getTotalPositionSize(address trader, address baseToken) external view returns (int256 totalPositionSize);

    /// @notice Get total position value of trader's baseToken market
    /// @dev A negative returned value is only be used when calculating pnl,
    /// @dev we use mark price to calc position value
    /// @param trader The address of trader
    /// @param baseToken The address of baseToken
    /// @return totalPositionValue Total position value of trader's baseToken market
    function getTotalPositionValue(address trader, address baseToken) external view returns (int256 totalPositionValue);

    /// @notice Get all market position abs value of trader
    /// @param trader The address of trader
    /// @return totalAbsPositionValue Sum up positions value of every market
    function getTotalAbsPositionValue(address trader) external view returns (uint256 totalAbsPositionValue);

    /// @notice Get liquidatable position size of trader's baseToken market
    /// @param trader The address of trader
    /// @param baseToken The address of baseToken
    /// @param accountValue The account value of trader
    /// @return liquidatablePositionSize The liquidatable position size of trader's baseToken market
    function getLiquidatablePositionSize(
        address trader,
        address baseToken,
        int256 accountValue
    ) external view returns (int256);

    /// @notice Get mark price of baseToken market
    /// @dev Mark price is the median of three prices as below.
    ///        1. current market price
    ///        2. market twap with 30 mins
    ///        3. index price + premium with 15 mins
    /// @dev If the parameters to calculate mark price are not set, returns index twap instead for backward compatible
    /// @dev If the market is paused, returns index twap instead, that will be the index twap while pausing market
    /// @param baseToken The address of baseToken
    /// @return price The mark price of baseToken market
    function getMarkPrice(address baseToken) external view returns (uint256);
}
