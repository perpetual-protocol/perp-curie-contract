pragma solidity 0.7.6;
pragma abicoder v2;

import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { PositionKey } from "@uniswap/v3-periphery/contracts/libraries/PositionKey.sol";
import { LiquidityAmounts } from "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";
import { PoolAddress } from "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";

/**
 * Uniswap's v3 pool: token0 & token1
 * -> token0's price = token1 / token0; tick index = log(1.0001, token0's price)
 * Our system: base & quote
 * -> base's price = quote / base; tick index = log(1.0001, base price)
 * Figure out: (base, quote) == (token0, token1) or (token1, token0)
 */
library UniswapV3Broker {
    struct MintParams {
        IUniswapV3Pool pool;
        address baseToken;
        address quoteToken;
        int24 lowerTick;
        int24 upperTick;
        uint256 base;
        uint256 quote;
    }

    struct MintResponse {
        uint256 base;
        uint256 quote;
        uint128 liquidity;
        uint256 feeGrowthInsideLastBase;
        uint256 feeGrowthInsideLastQuote;
    }

    /**
     @return response .liquidity currently can be 0
     */
    function mint(MintParams memory params) internal returns (MintResponse memory response) {
        // zero inputs
        require(params.base > 0 || params.quote > 0, "UB_ZIs");

        // make base & quote into the right order
        bool isBase0Quote1 = _isBase0Quote1(params.pool, params.baseToken, params.quoteToken);
        int24 lowerTick;
        int24 upperTick;
        uint256 token0;
        uint256 token1;
        if (isBase0Quote1) {
            lowerTick = params.lowerTick;
            upperTick = params.upperTick;
            token0 = params.base;
            token1 = params.quote;
        } else {
            lowerTick = -params.upperTick;
            upperTick = -params.lowerTick;
            token0 = params.quote;
            token1 = params.base;
        }

        // fetch fee growth states if there is already liquidity
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        if (_getPositionLiquidity(params.pool, lowerTick, upperTick) > 0) {
            // get positionKey of the caller contract
            // FIXME
            // check if the case sensitive of address(this) break the PositionKey computing
            bytes32 positionKey = PositionKey.compute(address(this), lowerTick, upperTick);

            // get feeGrowthInside{0,1}LastX128
            (, feeGrowthInside0LastX128, feeGrowthInside1LastX128, , ) = params.pool.positions(positionKey);
        }

        // get current price
        (uint160 sqrtPriceX96, , , , , , ) = params.pool.slot0();
        // get the equivalent amount of liquidity from amount0 & amount1 with current price
        response.liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtRatioAtTick(lowerTick),
            TickMath.getSqrtRatioAtTick(upperTick),
            token0,
            token1
        );

        // call mint()
        uint256 addedAmount0;
        uint256 addedAmount1;
        // FIXME: currently it's okay to have liquidity == 0; should decide whether to block this in the future
        if (response.liquidity > 0) {
            (addedAmount0, addedAmount1) = params.pool.mint(
                address(this),
                lowerTick,
                upperTick,
                response.liquidity,
                // FIXME
                // depends on what verification we need to check inside callback
                abi.encode(msg.sender)
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

    function getPool(
        address factory,
        address quoteToken,
        address baseToken,
        uint24 feeRatio
    ) internal view returns (address) {
        PoolAddress.PoolKey memory poolKeys = PoolAddress.getPoolKey(quoteToken, baseToken, feeRatio);
        return IUniswapV3Factory(factory).getPool(poolKeys.token0, poolKeys.token1, feeRatio);
    }

    function _isBase0Quote1(
        IUniswapV3Pool pool,
        address baseToken,
        address quoteToken
    ) private view returns (bool) {
        address token0 = pool.token0();
        address token1 = pool.token1();
        if (baseToken == token0 && quoteToken == token1) return true;
        if (baseToken == token1 && quoteToken == token0) return false;
        // pool token mismatched. should throw from earlier check
        revert("UB_PTM");
    }

    function _getPositionLiquidity(
        IUniswapV3Pool pool,
        int24 tickLower,
        int24 tickUpper
    ) private view returns (uint128 liquidity) {
        bytes32 positionKey = PositionKey.compute(address(this), tickLower, tickUpper);
        (liquidity, , , , ) = pool.positions(positionKey);
    }
}
