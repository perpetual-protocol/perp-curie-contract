pragma solidity 0.7.6;

import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { PositionKey } from "@uniswap/v3-periphery/contracts/libraries/PositionKey.sol";
import { LiquidityAmounts } from "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";

library UniswapBroker {
    function mint(
        IUniswapV3Pool pool,
        int24 tickLower,
        int24 tickUpper,
        uint256 base,
        uint256 quote
    )
        internal
        returns (
            uint256 addedBase,
            uint256 addedQuote,
            uint128 liquidityDelta,
            uint256 feeGrowthInsideLastBase,
            uint256 feeGrowthInsideLastQuote
        )
    {
        // requirements check
        // zero inputs
        require(base > 0 || quote > 0, "ZIs");

        // make base & quote into the right order
        uint256 amount0;
        uint256 amount1;
        (address baseAddr, address quoteAddr) = getTokensFromPool(pool);
        if (baseAddr < quoteAddr) {
            amount0 = base;
            amount1 = quote;
        } else {
            amount0 = quote;
            amount1 = base;
        }

        // fetch the liquidity of ClearingHouse
        uint128 liquidity = getPositionLiquidity(pool, address(this), tickLower, tickUpper);

        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        // poke the pool to update fees if there's liquidity already
        // check if this if block is necessary
        if (liquidity > 0) {
            pool.burn(tickLower, tickUpper, 0);

            // get positionKey of ClearingHouse
            bytes32 positionKeyCH = getPoolKeyCH(address(this), tickLower, tickUpper);
            // get feeGrowthInside{0,1}LastX128
            (, feeGrowthInside0LastX128, feeGrowthInside1LastX128, , ) = pool.positions(positionKeyCH);
        }

        // get current price
        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
        // get the equivalent amount of liquidity from amount0 & amount1
        liquidityDelta = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtRatioAtTick(tickLower),
            TickMath.getSqrtRatioAtTick(tickUpper),
            amount0,
            amount1
        );

        // call mint()
        // verify if this liquidityDelta is necessary
        uint256 addedAmount0;
        uint256 addedAmount1;
        if (liquidityDelta > 0) {
            (addedAmount0, addedAmount1) = pool.mint(
                address(this),
                tickLower,
                tickUpper,
                liquidityDelta,
                abi.encode(this)
            );
        }

        // make base & quote into the right order
        if (baseAddr < quoteAddr) {
            addedBase = addedAmount0;
            addedQuote = addedAmount1;
            feeGrowthInsideLastBase = feeGrowthInside0LastX128;
            feeGrowthInsideLastQuote = feeGrowthInside1LastX128;
        } else {
            addedQuote = addedAmount0;
            addedBase = addedAmount1;
            feeGrowthInsideLastQuote = feeGrowthInside0LastX128;
            feeGrowthInsideLastBase = feeGrowthInside1LastX128;
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
