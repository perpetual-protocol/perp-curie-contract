// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { Funding } from "../lib/Funding.sol";
import { OpenOrder } from "../lib/OpenOrder.sol";

interface IOrderBook {
    struct AddLiquidityParams {
        address trader;
        address baseToken;
        uint256 base;
        uint256 quote;
        int24 lowerTick;
        int24 upperTick;
        Funding.Growth fundingGrowthGlobal;
    }

    struct RemoveLiquidityParams {
        address maker;
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
    }

    struct AddLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
        uint128 liquidity;
        bytes32 orderId;
    }

    struct RemoveLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
        int256 deltaTakerBase;
        int256 deltaTakerQuote;
    }

    struct ReplaySwapParams {
        address baseToken;
        bool isBaseToQuote;
        bool shouldUpdateState;
        int256 amount;
        uint160 sqrtPriceLimitX96;
        uint24 exchangeFeeRatio;
        uint24 uniswapFeeRatio;
        Funding.Growth globalFundingGrowth;
    }

    /// @param insuranceFundFee = fee * insuranceFundFeeRatio
    struct ReplaySwapResponse {
        int24 tick;
        uint256 fee;
        uint256 insuranceFundFee;
    }

    struct MintCallbackData {
        address trader;
        address pool;
    }

    /// @param exchange the address of exchange contract
    event ExchangeChanged(address indexed exchange);

    function addLiquidity(AddLiquidityParams calldata params) external returns (AddLiquidityResponse memory);

    function removeLiquidity(RemoveLiquidityParams calldata params) external returns (RemoveLiquidityResponse memory);

    function removeLiquidityByIds(
        address maker,
        address baseToken,
        bytes32[] calldata orderIds
    ) external returns (RemoveLiquidityResponse memory);

    function updateFundingGrowthAndLiquidityCoefficientInFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory fundingGrowthGlobal
    ) external returns (int256 liquidityCoefficientInFundingPayment);

    function replaySwap(ReplaySwapParams memory params) external returns (ReplaySwapResponse memory);

    function updateOrderDebt(
        bytes32 orderId,
        int256 deltaBaseDebt,
        int256 deltaQuoteDebt
    ) external;

    function getOpenOrderIds(address trader, address baseToken) external view returns (bytes32[] memory);

    function getOpenOrderById(bytes32 orderId) external view returns (OpenOrder.Info memory);

    function getOpenOrder(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view returns (OpenOrder.Info memory);

    function hasOrder(address trader, address[] calldata tokens) external view returns (bool);

    function getTotalQuoteAmountInPools(address trader, address[] calldata baseTokens) external view returns (uint256);

    function getTotalTokenAmountInPool(
        address trader,
        address baseToken,
        bool fetchBase
    ) external view returns (uint256 tokenAmount);

    function getLiquidityCoefficientInFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory fundingGrowthGlobal
    ) external view returns (int256 liquidityCoefficientInFundingPayment);

    function getFeeGrowthGlobal(address baseToken) external view returns (uint256);

    function getOwedFee(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view returns (uint256);

    function getExchange() external view returns (address);
}
