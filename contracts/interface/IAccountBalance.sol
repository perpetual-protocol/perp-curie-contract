// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AccountMarket } from "../lib/AccountMarket.sol";

interface IAccountBalance {
    //
    // EVENT
    //

    /// @dev Emit whenever a trader's `owedRealizedPnl` is updated
    /// @param trader The address of the trader
    /// @param amount The amount changed
    event PnlRealized(address indexed trader, int256 amount);

    /// @dev Settle account balance and deregister base token
    /// @param maker The address of the maker
    /// @param baseToken The address of the market's base token
    /// @param base Amount of base token removed from pool
    /// @param quote Amount of quote token removed from pool
    /// @param fee Amount of fee collected from pool
    function settleBalanceAndDeregister(
        address maker,
        address baseToken,
        int256 base,
        int256 quote,
        int256 fee
    ) external;

    function addBalance(
        address trader,
        address baseToken,
        int256 base,
        int256 quote,
        int256 owedRealizedPnl
    ) external;

    function addOwedRealizedPnl(address trader, int256 delta) external;

    function settleQuoteToPnl(
        address trader,
        address baseToken,
        int256 amount
    ) external;

    function updateTwPremiumGrowthGlobal(
        address trader,
        address baseToken,
        int256 lastTwPremiumGrowthGlobalX96
    ) external;

    /// @dev Deregister base token and this function is expensive
    /// @param trader The address of the trader
    /// @param baseToken The address of the trader's base token
    function deregisterBaseToken(address trader, address baseToken) external;

    function registerBaseToken(address trader, address baseToken) external;

    /// @dev this function is now only called by Vault.withdraw()
    function settleOwedRealizedPnl(address trader) external returns (int256 pnl);

    function getBaseTokens(address trader) external view returns (address[] memory);

    function hasOrder(address trader) external view returns (bool);

    /// @dev get margin requirement for determining liquidation.
    /// Different purpose from `_getTotalMarginRequirement` which is for free collateral calculation.
    function getLiquidateMarginRequirement(address trader) external view returns (int256);

    function getTotalDebtValue(address trader) external view returns (uint256);

    function getOwedAndUnrealizedPnl(address trader) external view returns (int256, int256);

    function getAccountInfo(address trader, address baseToken) external view returns (AccountMarket.Info memory);

    function getBase(address trader, address baseToken) external view returns (int256);

    function getQuote(address trader, address baseToken) external view returns (int256);

    /// @return netQuoteBalance = quote.balance + totalQuoteInPools
    function getNetQuoteBalance(address trader) external view returns (int256);

    function getPositionSize(address trader, address baseToken) external view returns (int256);

    /// @dev a negative returned value is only be used when calculating pnl
    /// @dev we use 15 mins twap to calc position value
    function getPositionValue(address trader, address baseToken) external view returns (int256);
}
