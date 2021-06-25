pragma solidity 0.7.6;
pragma abicoder v2;

import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { PositionKey } from "@uniswap/v3-periphery/contracts/libraries/PositionKey.sol";
import { LiquidityAmounts } from "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";
import { PoolAddress } from "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";

/**
 * Uniswap's v3 pool: token0 & token1
 * -> token0's price = token1 / token0; tick index = log(1.0001, token0's price)
 * Our system: base & quote
 * -> base's price = quote / base; tick index = log(1.0001, base price)
 * Figure out: (base, quote) == (token0, token1) or (token1, token0)
 */
library UniswapV3Broker {
    using SafeCast for uint256;
    using SafeCast for uint128;
    using SafeCast for int256;

    struct AddLiquidityParams {
        address pool;
        address baseToken;
        address quoteToken;
        int24 lowerTick;
        int24 upperTick;
        uint256 base;
        uint256 quote;
    }

    struct AddLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint128 liquidity;
        uint256 feeGrowthInsideLastBase;
        uint256 feeGrowthInsideLastQuote;
    }

    struct RemoveLiquidityParams {
        address pool;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
    }

    struct RemoveLiquidityResponse {
        uint256 base; // amount of base token received from burning the liquidity (excl. fee)
        uint256 quote; // amount of quote token received from burning the liquidity (excl. fee)
        uint256 feeGrowthInsideLastBase;
        uint256 feeGrowthInsideLastQuote;
    }

    struct SwapCallbackData {
        bytes path;
        address payer;
    }

    struct SwapParams {
        IUniswapV3Pool pool;
        address baseToken;
        address quoteToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        SwapCallbackData data;
    }

    struct SwapResponse {
        uint256 base;
        uint256 quote;
    }

    function addLiquidity(AddLiquidityParams memory params) internal returns (AddLiquidityResponse memory response) {
        // zero inputs
        require(params.base > 0 || params.quote > 0, "UB_ZIs");

        // make base & quote into the right order
        bool isBase0Quote1 = _isBase0Quote1(params.pool, params.baseToken, params.quoteToken);
        (uint256 token0, uint256 token1, int24 lowerTick, int24 upperTick) =
            _baseQuoteToToken01(isBase0Quote1, params.base, params.quote, params.lowerTick, params.upperTick);

        {
            // get current price
            (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(params.pool).slot0();
            // get the equivalent amount of liquidity from amount0 & amount1 with current price
            response.liquidity = LiquidityAmounts.getLiquidityForAmounts(
                sqrtPriceX96,
                TickMath.getSqrtRatioAtTick(lowerTick),
                TickMath.getSqrtRatioAtTick(upperTick),
                token0,
                token1
            );
            // TODO revision needed. We might not want to revert on zero liquidity but not sure atm
            // UB_ZL: zero liquidity
            require(response.liquidity > 0, "UB_ZL");
        }

        {
            // fetch the fee growth state if this has liquidity
            (uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128) =
                _getFeeGrowthInside(params.pool, params.lowerTick, params.upperTick);

            // call mint()
            uint256 addedAmount0;
            uint256 addedAmount1;
            // we use baseToken for verification since CH knows which base token maps to which pool
            bytes memory data = abi.encode(params.baseToken);
            (addedAmount0, addedAmount1) = IUniswapV3Pool(params.pool).mint(
                address(this),
                lowerTick,
                upperTick,
                response.liquidity,
                data
            );

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
    }

    function removeLiquidity(RemoveLiquidityParams memory params)
        internal
        returns (RemoveLiquidityResponse memory response)
    {
        // call burn(), this will only update tokensOwed instead of transfer the token
        (uint256 amount0Burned, uint256 amount1Burned) =
            IUniswapV3Pool(params.pool).burn(params.lowerTick, params.upperTick, params.liquidity);

        // call collect to `transfer` tokens to CH, the amount including every trader pooled into the same range
        IUniswapV3Pool(params.pool).collect(
            address(this),
            params.lowerTick,
            params.upperTick,
            type(uint128).max,
            type(uint128).max
        );

        // fetch the fee growth state if this has liquidity
        (uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128) =
            _getFeeGrowthInside(params.pool, params.lowerTick, params.upperTick);

        // make base & quote into the right order
        response.base = amount0Burned;
        response.quote = amount1Burned;
        response.feeGrowthInsideLastBase = feeGrowthInside0LastX128;
        response.feeGrowthInsideLastQuote = feeGrowthInside1LastX128;
    }

    function swap(SwapParams memory params) internal returns (SwapResponse memory response) {
        // zero input
        require(params.amount > 0, "UB_ZI");

        // UniswapV3Pool will use a signed value to determine isExactInput or not.
        int256 specifiedAmount = params.isExactInput ? params.amount.toInt256() : -params.amount.toInt256();

        // FIXME: need confirmation
        // signedAmount0 & signedAmount1 are deltaAmount, in the perspective of the pool
        // > 0: pool gets; user pays
        // < 0: pool provides; user gets
        (int256 signedAmount0, int256 signedAmount1) =
            params.pool.swap(
                address(this),
                params.isBaseToQuote,
                specifiedAmount,
                // FIXME: suppose the reason is for under/overflow but need confirmation
                params.sqrtPriceLimitX96 == 0
                    ? (params.isBaseToQuote ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                    : params.sqrtPriceLimitX96,
                // FIXME
                // depends on what verification we need to check inside callback
                abi.encode(params.data)
            );

        uint256 amount0 = signedAmount0 < 0 ? (-signedAmount0).toUint256() : signedAmount0.toUint256();
        uint256 amount1 = signedAmount1 < 0 ? (-signedAmount1).toUint256() : signedAmount1.toUint256();

        // isExactInput = true, isZeroForOne = true => exact token0
        // isExactInput = false, isZeroForOne = false => exact token0
        // isExactInput = false, isZeroForOne = true => exact token1
        // isExactInput = true, isZeroForOne = false => exact token1
        uint256 exactAmount = params.isExactInput == params.isBaseToQuote ? amount0 : amount1;
        // FIXME: why is this check necessary for exactOutput but not for exactInput?
        // it's technically possible to not receive the full output amount,
        // so if no price limit has been specified, require this possibility away
        // incorrect output amount
        if (!params.isExactInput && params.sqrtPriceLimitX96 == 0) require(exactAmount == params.amount, "UB_IOA");

        (response.base, response.quote) = (amount0, amount1);
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
        address pool,
        address baseToken,
        address quoteToken
    ) private view returns (bool) {
        address token0 = IUniswapV3Pool(pool).token0();
        address token1 = IUniswapV3Pool(pool).token1();
        if (baseToken == token0 && quoteToken == token1) return true;
        if (baseToken == token1 && quoteToken == token0) return false;
        // pool token mismatched. should throw from earlier check
        revert("UB_PTM");
    }

    function _baseQuoteToToken01(
        bool isBase0Quote1,
        uint256 base,
        uint256 quote,
        int24 baseQuoteLowerTick,
        int24 baseQuoteUpperTick
    )
        private
        pure
        returns (
            uint256 token0,
            uint256 token1,
            int24 lowerTick,
            int24 upperTick
        )
    {
        if (isBase0Quote1) {
            lowerTick = baseQuoteLowerTick;
            upperTick = baseQuoteUpperTick;
            token0 = base;
            token1 = quote;
        } else {
            lowerTick = -baseQuoteUpperTick;
            upperTick = -baseQuoteLowerTick;
            token0 = quote;
            token1 = base;
        }
    }

    function _getFeeGrowthInside(
        address pool,
        int24 lowerTick,
        int24 upperTick
    ) private view returns (uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128) {
        if (_getPositionLiquidity(pool, lowerTick, upperTick) > 0) {
            // get this' positionKey
            // FIXME
            // check if the case sensitive of address(this) break the PositionKey computing
            bytes32 positionKey = PositionKey.compute(address(this), lowerTick, upperTick);

            // get feeGrowthInside{0,1}LastX128
            (, feeGrowthInside0LastX128, feeGrowthInside1LastX128, , ) = IUniswapV3Pool(pool).positions(positionKey);
        }
    }

    function _getPositionLiquidity(
        address pool,
        int24 tickLower,
        int24 tickUpper
    ) private view returns (uint128 liquidity) {
        bytes32 positionKey = PositionKey.compute(address(this), tickLower, tickUpper);
        (liquidity, , , , ) = IUniswapV3Pool(pool).positions(positionKey);
    }
}
