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
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        Funding.Growth fundingGrowthGlobal;
    }

    struct SwapResponse {
        uint256 deltaAvailableBase;
        uint256 deltaAvailableQuote;
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        uint256 fee;
        uint256 insuranceFundFee;
        int24 tick;
        int256 realizedPnl;
        int256 openNotional;
    }

    function swap(SwapParams memory params) external returns (SwapResponse memory);

    function getPool(address baseToken) external view returns (address);

    function getTick(address baseToken) external view returns (int24);

    function getSqrtMarkTwapX96(address baseToken, uint32 twapInterval) external view returns (uint160);

    function getMaxTickCrossedWithinBlock(address baseToken) external view returns (uint24);

    function getAllPendingFundingPayment(address trader) external view returns (int256);

    function getPendingFundingPayment(address trader, address baseToken) external view returns (int256);
}
