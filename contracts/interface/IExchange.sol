// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { Funding } from "../lib/Funding.sol";

interface IExchange {
    /// @param amount when closing position, amount(uint256) == takerPositionSize(int256),
    ///        as amount is assigned as takerPositionSize in ClearingHouse.closePosition()
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
        uint256 deltaAvailableBase;
        uint256 deltaAvailableQuote;
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        uint256 fee;
        int256 openNotional;
        int256 realizedPnl;
        uint256 sqrtPriceAfterX96;
        int24 tick;
        bool isPartialClose;
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
        int256 deltaAvailableBase;
        int256 deltaAvailableQuote;
    }

    /// @param fundingPayment > 0: payment, < 0 : receipt
    event FundingPaymentSettled(address indexed trader, address indexed baseToken, int256 fundingPayment);

    event FundingUpdated(address indexed baseToken, uint256 markTwap, uint256 indexTwap);

    event MaxTickCrossedWithinBlockChanged(address indexed baseToken, uint24 maxTickCrossedWithinBlock);

    /// @param accountBalance The address of accountBalance contract
    event AccountBalanceChanged(address accountBalance);

    function swap(SwapParams memory params) external returns (SwapResponse memory);

    function settleFunding(address trader, address baseToken)
        external
        returns (Funding.Growth memory fundingGrowthGlobal);

    function getMaxTickCrossedWithinBlock(address baseToken) external view returns (uint24);

    function getAllPendingFundingPayment(address trader) external view returns (int256);

    function getPendingFundingPayment(address trader, address baseToken) external view returns (int256);

    /// @dev this function calculates the up-to-date globalFundingGrowth and twaps and pass them out
    /// @return fundingGrowthGlobal the up-to-date globalFundingGrowth
    /// @return markTwap only for settleFunding()
    /// @return indexTwap only for settleFunding()
    function getFundingGrowthGlobalAndTwaps(address baseToken)
        external
        view
        returns (
            Funding.Growth memory fundingGrowthGlobal,
            uint256 markTwap,
            uint256 indexTwap
        );

    function getTick(address baseToken) external view returns (int24);

    function getSqrtMarkTwapX96(address baseToken, uint32 twapInterval) external view returns (uint160);

    function getPnlToBeRealized(RealizePnlParams memory params) external view returns (int256);

    function getOrderBook() external view returns (address);

    function getAccountBalance() external view returns (address);

    function getClearingHouseConfig() external view returns (address);

    function getInsuranceFund() external view returns (address);
}
