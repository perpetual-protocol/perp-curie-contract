// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { Funding } from "../lib/Funding.sol";

interface IExchange {
    /// @param amount when closing position, amount(uint256) == takerPositionSize(int256),
    /// as amount is assigned as takerPositionSize in ClearingHouse.closePosition()
    struct SwapParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        bool isClose;
        uint256 amount;
        uint160 sqrtPriceLimitX96;
    }

    struct SwapResponse {
        uint256 base;
        uint256 quote;
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        uint256 fee;
        uint256 insuranceFundFee;
        int256 pnlToBeRealized;
        uint256 sqrtPriceAfterX96;
        int24 tick;
        bool isPartialClose;
        uint24 closedRatio;
    }

    struct SwapCallbackData {
        address trader;
        address baseToken;
        address pool;
        uint24 uniswapFeeRatio;
        uint256 fee;
    }

    struct RealizePnlParams {
        address trader;
        address baseToken;
        int256 base;
        int256 quote;
    }

    /// @notice Emitted when the global funding growth is updated
    /// @param baseToken Address of the base token
    /// @param marketTwap The market twap price when the funding growth is updated
    /// @param indexTwap The index twap price when the funding growth is updated
    event FundingUpdated(address indexed baseToken, uint256 marketTwap, uint256 indexTwap);

    /// @notice Emitted when maxTickCrossedWithinBlock is updated
    /// @param baseToken Address of the base token
    /// @param maxTickCrossedWithinBlock Max tick allowed to be crossed within block when reducing position
    event MaxTickCrossedWithinBlockChanged(address indexed baseToken, uint24 maxTickCrossedWithinBlock);

    /// @notice Emitted when accountBalance is updated
    /// @param accountBalance The address of accountBalance contract
    event AccountBalanceChanged(address accountBalance);

    /// @notice The actual swap function
    /// @dev can only be called from ClearingHouse
    /// @param params The parameters of the swap
    /// @return swapResponse The result of the swap
    function swap(SwapParams memory params) external returns (SwapResponse memory swapResponse);

    /// @notice Settle the funding payment for the time interval since the last settlement
    /// @dev This function should be called at the beginning of every high-level function, such as `openPosition()`
    ///      while it doesn't matter who calls this function
    ///      this function 1. settles personal funding payment 2. updates global funding growth
    ///      personal funding payment is settled whenever there is pending funding payment
    ///      the global funding growth update only happens once per unique timestamp (not blockNumber, due to Arbitrum)
    /// @return fundingPayment the funding payment of a trader in one market should be settled into owned realized Pnl
    /// @return fundingGrowthGlobal the up-to-date globalFundingGrowth, usually used for later calculations
    function settleFunding(address trader, address baseToken)
        external
        returns (int256 fundingPayment, Funding.Growth memory fundingGrowthGlobal);

    /// @notice Get the max ticks allowed to be crossed within a block when reducing position
    /// @param baseToken Address of the base token
    /// @return maxTickCrossedWithinBlock The max ticks allowed to be crossed within a block when reducing position
    function getMaxTickCrossedWithinBlock(address baseToken) external view returns (uint24 maxTickCrossedWithinBlock);

    /// @notice Get all the pending funding payment for a trader
    /// @return pendingFundingPayment The pending funding payment of the trader.
    /// Positive value means the trader pays funding, negative value means the trader receives funding.
    function getAllPendingFundingPayment(address trader) external view returns (int256 pendingFundingPayment);

    /// @notice Check if current price spread between market price and index twap is over maximum price spread.
    /// @param baseToken Address of the base token
    /// @return true if over the maximum price spread
    function isOverPriceSpread(address baseToken) external view returns (bool);

    /// @notice Get the pending funding payment for a trader in a given market
    /// @dev this is the view version of _updateFundingGrowth()
    /// @return pendingFundingPayment The pending funding payment of a trader in one market,
    /// including liquidity & balance coefficients. Positive value means the trader pays funding,
    /// negative value means the trader receives funding.
    function getPendingFundingPayment(address trader, address baseToken)
        external
        view
        returns (int256 pendingFundingPayment);

    /// @notice **Deprecated function, will be removed in the next release, use `getSqrtMarketTwapX96()` instead**
    /// Get the square root of the market twap price with the given time interval
    /// @dev The return value is a X96 number
    /// @param baseToken Address of the base token
    /// @param twapInterval The time interval in seconds
    /// @return sqrtMarkTwapX96 The square root of the market twap price
    function getSqrtMarkTwapX96(address baseToken, uint32 twapInterval) external view returns (uint160 sqrtMarkTwapX96);

    /// @notice Get the square root of the market twap price with the given time interval
    /// @dev The return value is a X96 number
    /// @param baseToken Address of the base token
    /// @param twapInterval The time interval in seconds
    /// @return sqrtMarketTwapX96 The square root of the market twap price
    function getSqrtMarketTwapX96(address baseToken, uint32 twapInterval)
        external
        view
        returns (uint160 sqrtMarketTwapX96);

    /// @notice Get the pnl that can be realized if trader reduce position
    /// @dev This function normally won't be needed by traders, but it might be useful for 3rd party
    /// @param params The params needed to do the query, encoded as `RealizePnlParams` in calldata
    /// @return pnlToBeRealized The pnl that can be realized if trader reduce position
    function getPnlToBeRealized(RealizePnlParams memory params) external view returns (int256 pnlToBeRealized);

    /// @notice Get `OrderBook` contract address
    /// @return orderBook `OrderBook` contract address
    function getOrderBook() external view returns (address orderBook);

    /// @notice Get `AccountBalance` contract address
    /// @return accountBalance `AccountBalance` contract address
    function getAccountBalance() external view returns (address accountBalance);

    /// @notice Get `ClearingHouseConfig` contract address
    /// @return clearingHouse `ClearingHouseConfig` contract address
    function getClearingHouseConfig() external view returns (address clearingHouse);
}
