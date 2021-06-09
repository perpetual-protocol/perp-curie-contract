pragma solidity 0.7.6;
pragma abicoder v2;

import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { PositionKey } from "@uniswap/v3-periphery/contracts/libraries/PositionKey.sol";
import { PoolAddress } from "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";
import { LiquidityAmounts } from "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";

library UniswapV3Broker {
    struct MintCallbackData {
        PoolAddress.PoolKey poolKey;
        address payer;
    }

    struct MintParams {
        IUniswapV3Pool pool;
        address baseToken;
        address quoteToken;
        int24 tickLower;
        int24 tickUpper;
        uint256 baseAmount;
        uint256 quoteAmount;
    }

    struct MintResponse {
        uint256 base;
        uint256 quote;
        uint128 liquidity;
        uint256 feeGrowthInsideLastBase;
        uint256 feeGrowthInsideLastQuote;
    }

    function mint(MintParams memory params) internal returns (MintResponse memory response) {
        // requirements check
        // zero inputs
        require(params.baseAmount > 0 || params.quoteAmount > 0, "ZIs");

        // make base & quote into the right order
        bool isBase0Quote1 = _isBase0Quote1(params.pool, params.baseToken, params.quoteToken);

        uint256 amount0;
        uint256 amount1;
        if (isBase0Quote1) {
            amount0 = params.baseAmount;
            amount1 = params.quoteAmount;
        } else {
            amount0 = params.quoteAmount;
            amount1 = params.baseAmount;
        }

        // fetch the liquidity of ClearingHouse
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        // poke the pool to update fees if there's liquidity already
        // check if this if block is necessary
        if (_getPositionLiquidity(params.pool, address(this), params.tickLower, params.tickUpper) > 0) {
            params.pool.burn(params.tickLower, params.tickUpper, 0);

            // get positionKey of ClearingHouse
            bytes32 positionKey = PositionKey.compute(address(this), params.tickLower, params.tickUpper);

            // get feeGrowthInside{0,1}LastX128
            (, feeGrowthInside0LastX128, feeGrowthInside1LastX128, , ) = params.pool.positions(positionKey);
        }

        // get current price
        (uint160 sqrtPriceX96, , , , , , ) = params.pool.slot0();
        // get the equivalent amount of liquidity from amount0 & amount1
        response.liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtRatioAtTick(params.tickLower),
            TickMath.getSqrtRatioAtTick(params.tickUpper),
            amount0,
            amount1
        );

        // call mint()
        // verify if this liquidity is necessary
        uint256 addedAmount0;
        uint256 addedAmount1;
        if (response.liquidity > 0) {
            PoolAddress.PoolKey memory poolKey =
                PoolAddress.getPoolKey(params.pool.token0(), params.pool.token1(), params.pool.fee());

            (addedAmount0, addedAmount1) = params.pool.mint(
                address(this),
                params.tickLower,
                params.tickUpper,
                response.liquidity,
                abi.encode(MintCallbackData({ poolKey: poolKey, payer: msg.sender }))
            );
        }

        // make base & quote into the right order
        if (isBase0Quote1) {
            response.base = addedAmount0;
            response.quote = addedAmount1;
            response.feeGrowthInsideLastBase = feeGrowthInside0LastX128;
            response.feeGrowthInsideLastQuote = feeGrowthInside1LastX128;
        } else {
            response.quote = addedAmount0;
            response.base = addedAmount1;
            response.feeGrowthInsideLastQuote = feeGrowthInside0LastX128;
            response.feeGrowthInsideLastBase = feeGrowthInside1LastX128;
        }
    }

    function _isBase0Quote1(
        IUniswapV3Pool pool,
        address baseToken,
        address quoteToken
    ) private view returns (bool) {
        address token0 = pool.token0();
        address token1 = pool.token1();
        if (baseToken == token0 && quoteToken == token1) return true;
        if (base == token1 && quoteToken == token0) return false;
        // pool token mismatched. should throw from earlier check
        revert("PTM");
    }

    function _getPositionLiquidity(
        IUniswapV3Pool pool,
        address owner,
        int24 tickLower,
        int24 tickUpper
    ) private view returns (uint128 liquidity) {
        bytes32 positionKey = PositionKey.compute(owner, tickLower, tickUpper);
        (liquidity, , , , ) = pool.positions(positionKey);
    }
}
