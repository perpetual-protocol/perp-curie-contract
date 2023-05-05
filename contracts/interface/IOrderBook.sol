// SPDX-License-Identifier: GPL-3.0-or-later
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
    }

    struct RemoveLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
        int256 takerBase;
        int256 takerQuote;
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
        address pool;
        uint24 insuranceFundFeeRatio;
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

    /// @notice Emitted when the `Exchange` contract address changed
    /// @param exchange The address of exchange contract
    event ExchangeChanged(address indexed exchange);

    /// @notice Add liquidity logic
    /// @dev Only used by `ClearingHouse` contract
    /// @param params Add liquidity params, detail on `IOrderBook.AddLiquidityParams`
    /// @return response Add liquidity response, detail on `IOrderBook.AddLiquidityResponse`
    function addLiquidity(AddLiquidityParams calldata params) external returns (AddLiquidityResponse memory response);

    /// @notice Remove liquidity logic, only used by `ClearingHouse` contract
    /// @param params Remove liquidity params, detail on `IOrderBook.RemoveLiquidityParams`
    /// @return response Remove liquidity response, detail on `IOrderBook.RemoveLiquidityResponse`
    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        returns (RemoveLiquidityResponse memory response);

    /// @dev This is the non-view version of `getLiquidityCoefficientInFundingPayment()`,
    /// only can be called by `Exchange` contract
    /// @param trader The trader address
    /// @param baseToken The base token address
    /// @param fundingGrowthGlobal The funding growth info, detail on `Funding.Growth`
    /// @return liquidityCoefficientInFundingPayment the funding payment of all orders/liquidity of a maker
    function updateFundingGrowthAndLiquidityCoefficientInFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory fundingGrowthGlobal
    ) external returns (int256 liquidityCoefficientInFundingPayment);

    /// @notice Replay the swap and get the swap result (price impact and swap fee),
    /// only can be called by `Exchange` contract;
    /// @dev `ReplaySwapResponse.insuranceFundFee = fee * insuranceFundFeeRatio`
    /// @param params ReplaySwap params, detail on `IOrderBook.ReplaySwapParams`
    /// @return response The swap result encoded in `ReplaySwapResponse`
    function replaySwap(ReplaySwapParams memory params) external returns (ReplaySwapResponse memory response);

    function updateOrderDebt(
        bytes32 orderId,
        int256 base,
        int256 quote
    ) external;

    /// @notice Get open order ids of a trader in the given market
    /// @param trader The trader address
    /// @param baseToken The base token address
    /// @return orderIds The open order ids
    function getOpenOrderIds(address trader, address baseToken) external view returns (bytes32[] memory orderIds);

    /// @notice Get open order info by given order id
    /// @param orderId The order id
    /// @return info The open order info encoded in `OpenOrder.Info`
    function getOpenOrderById(bytes32 orderId) external view returns (OpenOrder.Info memory info);

    /// @notice Get open order info by given base token, upper tick and lower tick
    /// @param trader The trader address
    /// @param baseToken The base token address
    /// @param upperTick The upper tick
    /// @param lowerTick The lower tick
    /// @return info he open order info encoded in `OpenOrder.Info`
    function getOpenOrder(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view returns (OpenOrder.Info memory info);

    /// @notice Check if the specified trader has order in given markets
    /// @param trader The trader address
    /// @param tokens The base token addresses
    /// @return hasOrder True if the trader has order in given markets
    function hasOrder(address trader, address[] calldata tokens) external view returns (bool hasOrder);

    /// @notice Get the total quote token amount and pending fees of all orders in given markets
    /// @param trader The trader address
    /// @param baseTokens The base token addresses
    /// @return totalQuoteAmountInPools The total quote token amount
    /// @return totalPendingFee The total pending fees in the orders
    function getTotalQuoteBalanceAndPendingFee(address trader, address[] calldata baseTokens)
        external
        view
        returns (int256 totalQuoteAmountInPools, uint256 totalPendingFee);

    /// @notice Get the total token amount (quote or base) and pending fees of all orders in the given market
    /// @param trader The trader address
    /// @param baseToken The base token addresses
    /// @param fetchBase True if fetch base token amount, false if fetch quote token amount
    /// @return tokenAmount The total quote/base token amount
    /// @return totalPendingFee The total pending fees in the orders
    function getTotalTokenAmountInPoolAndPendingFee(
        address trader,
        address baseToken,
        bool fetchBase
    ) external view returns (uint256 tokenAmount, uint256 totalPendingFee);

    /// @notice Get the total debt token amount (base or quote) of all orders in the given market
    /// @param trader The trader address
    /// @param baseToken The base token address
    /// @param fetchBase True if fetch base token amount, false if fetch quote token amount
    /// @return debtAmount The total debt token amount
    function getTotalOrderDebt(
        address trader,
        address baseToken,
        bool fetchBase
    ) external view returns (uint256 debtAmount);

    /// @notice Get the pending funding payment of all orders in the given market
    /// @dev This is the view version of `updateFundingGrowthAndLiquidityCoefficientInFundingPayment()`, so only
    /// part of the funding payment will be returned. Use it with caution because it does not return all the pending
    /// funding payment of orders. **Normally you won't need to use this function**
    /// @return liquidityCoefficientInFundingPayment the funding payment of all orders/liquidity of a maker
    function getLiquidityCoefficientInFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory fundingGrowthGlobal
    ) external view returns (int256 liquidityCoefficientInFundingPayment);

    /// @notice Get the pending fees of a order
    /// @param trader The trader address
    /// @param baseToken The base token address
    /// @param lowerTick The lower tick
    /// @param upperTick The upper tick
    /// @return fee The pending fees
    function getPendingFee(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view returns (uint256 fee);

    /// @notice Get `Exchange` contract address
    /// @return exchange The `Exchange` contract address
    function getExchange() external view returns (address exchange);
}
