// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { Funding } from "../lib/Funding.sol";

interface IExchange {
    struct SwapParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        bool isClose;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        Funding.Growth fundingGrowthGlobal;
    }

    struct SwapResponse {
        uint256 deltaAvailableBase;
        uint256 deltaAvailableQuote;
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        int24 tick;
    }

    struct SwapCallbackData {
        address trader;
        address baseToken;
        address pool;
        uint24 uniswapFeeRatio;
        uint256 fee;
    }

    //
    // EVENT
    //
    event PositionChanged(
        address indexed trader,
        address indexed baseToken,
        int256 exchangedPositionSize,
        int256 exchangedPositionNotional,
        uint256 fee,
        int256 openNotional,
        int256 realizedPnl
    );

    /// @param fundingPayment > 0: payment, < 0 : receipt
    event FundingPaymentSettled(address indexed trader, address indexed baseToken, int256 fundingPayment);
    event FundingUpdated(address indexed baseToken, uint256 markTwap, uint256 indexTwap);

    function swap(SwapParams memory params) external returns (SwapResponse memory);

    function settleAllFunding(address trader) external;

    function settleFunding(address trader, address baseToken)
        external
        returns (Funding.Growth memory fundingGrowthGlobal);

    function getMaxTickCrossedWithinBlock(address baseToken) external view returns (uint24);

    function getAllPendingFundingPayment(address trader) external view returns (int256);

    function getPendingFundingPayment(address trader, address baseToken) external view returns (int256);

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

    function getOpenNotional(address trader, address baseToken) external view returns (int256);

    function orderBook() external view returns (address);
}
