pragma solidity 0.7.6;
pragma abicoder v2;

import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { PositionKey } from "@uniswap/v3-periphery/contracts/libraries/PositionKey.sol";
import { LiquidityAmounts } from "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";

library UniswapBroker {
    struct MintParams {
        IUniswapV3Pool pool;
        int24 tickLower;
        int24 tickUpper;
        uint256 base;
        uint256 quote;
    }

    struct MintResponse {
        uint256 addedBase;
        uint256 addedQuote;
        uint128 liquidityDelta;
        uint256 feeGrowthInsideLastBase;
        uint256 feeGrowthInsideLastQuote;
    }

    function mint(MintParams memory params) internal returns (MintResponse memory response) {
        // requirements check
        // zero inputs
        require(params.base > 0 || params.quote > 0, "ZIs");

        // make base & quote into the right order
        uint256 amount0;
        uint256 amount1;
        (address baseAddr, address quoteAddr) = getTokensFromPool(params.pool);
        if (baseAddr < quoteAddr) {
            amount0 = params.base;
            amount1 = params.quote;
        } else {
            amount0 = params.quote;
            amount1 = params.base;
        }

        // fetch the liquidity of ClearingHouse
        {
            uint256 feeGrowthInside0LastX128;
            uint256 feeGrowthInside1LastX128;
            // poke the pool to update fees if there's liquidity already
            // check if this if block is necessary
            if (getPositionLiquidity(params.pool, address(this), params.tickLower, params.tickUpper) > 0) {
                params.pool.burn(params.tickLower, params.tickUpper, 0);

                // get positionKey of ClearingHouse
                bytes32 positionKeyCH = getPoolKeyCH(address(this), params.tickLower, params.tickUpper);
                // get feeGrowthInside{0,1}LastX128
                (, feeGrowthInside0LastX128, feeGrowthInside1LastX128, , ) = params.pool.positions(positionKeyCH);
            }

            // get current price
            (uint160 sqrtPriceX96, , , , , , ) = params.pool.slot0();
            // get the equivalent amount of liquidity from amount0 & amount1
            response.liquidityDelta = LiquidityAmounts.getLiquidityForAmounts(
                sqrtPriceX96,
                TickMath.getSqrtRatioAtTick(params.tickLower),
                TickMath.getSqrtRatioAtTick(params.tickUpper),
                amount0,
                amount1
            );

            // call mint()
            // verify if this liquidityDelta is necessary
            uint256 addedAmount0;
            uint256 addedAmount1;
            if (response.liquidityDelta > 0) {
                (addedAmount0, addedAmount1) = params.pool.mint(
                    address(this),
                    params.tickLower,
                    params.tickUpper,
                    response.liquidityDelta,
                    abi.encode(this)
                );
            }

            // make base & quote into the right order
            if (baseAddr < quoteAddr) {
                response.addedBase = addedAmount0;
                response.addedQuote = addedAmount1;
                response.feeGrowthInsideLastBase = feeGrowthInside0LastX128;
                response.feeGrowthInsideLastQuote = feeGrowthInside1LastX128;
            } else {
                response.addedQuote = addedAmount0;
                response.addedBase = addedAmount1;
                response.feeGrowthInsideLastQuote = feeGrowthInside0LastX128;
                response.feeGrowthInsideLastBase = feeGrowthInside1LastX128;
            }
        }
    }

    function getTokensFromPool(IUniswapV3Pool pool) internal view returns (address, address) {
        return (pool.token0(), pool.token1());
    }

    function getPositionLiquidity(
        IUniswapV3Pool pool,
        address owner,
        int24 tickLower,
        int24 tickUpper
    ) internal view returns (uint128 liquidity) {
        bytes32 positionKey = PositionKey.compute(owner, tickLower, tickUpper);
        (liquidity, , , , ) = pool.positions(positionKey);
    }

    function getPoolKeyCH(
        address _owner,
        int24 _tickLower,
        int24 _tickUpper
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(_owner, _tickLower, _tickUpper));
    }
}
