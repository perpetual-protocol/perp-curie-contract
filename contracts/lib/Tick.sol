pragma solidity 0.7.6;

library Tick {
    struct GrowthInfo {
        uint256 feeX128;
        int256 twPremiumX96;
        int256 twPremiumDivBySqrtPriceX96;
    }

    function getFeeGrowthInside(
        mapping(int24 => GrowthInfo) storage self,
        int24 lowerTick,
        int24 upperTick,
        int24 currentTick,
        uint256 feeGrowthGlobalX128
    ) internal view returns (uint256 feeGrowthInsideQuote) {
        uint256 lowerFeeGrowthOutside = self[lowerTick].feeX128;
        uint256 upperFeeGrowthOutside = self[upperTick].feeX128;

        uint256 feeGrowthBelow =
            currentTick >= lowerTick ? lowerFeeGrowthOutside : feeGrowthGlobalX128 - lowerFeeGrowthOutside;
        uint256 feeGrowthAbove =
            currentTick < upperTick ? upperFeeGrowthOutside : feeGrowthGlobalX128 - upperFeeGrowthOutside;

        // this value can underflow per feeGrowthOutside specs
        return feeGrowthGlobalX128 - feeGrowthBelow - feeGrowthAbove;
    }

    function getAllFundingGrowth(
        mapping(int24 => GrowthInfo) storage self,
        int24 lowerTick,
        int24 upperTick,
        int24 currentTick,
        int256 twPremiumGrowthGlobalX96,
        int256 twPremiumDivBySqrtPriceGrowthGlobalX96,
        int256 lastTwPremiumGrowthX96
    )
        internal
        view
        returns (
            int256 twPremiumGrowthInside,
            int256 twPremiumDivBySqrtPriceGrowthInside,
            int256 twPremiumGrowthOutside
        )
    {
        {
            int256 lowerTwPremiumGrowthOutside = self[lowerTick].twPremiumX96;
            int256 upperTwPremiumGrowthOutside = self[upperTick].twPremiumX96;

            int256 twPremiumGrowthBelow =
                currentTick >= lowerTick
                    ? lowerTwPremiumGrowthOutside
                    : twPremiumGrowthGlobalX96 - lowerTwPremiumGrowthOutside;
            int256 twPremiumGrowthAbove =
                currentTick < upperTick
                    ? upperTwPremiumGrowthOutside
                    : twPremiumGrowthGlobalX96 - upperTwPremiumGrowthOutside;

            twPremiumGrowthInside = twPremiumGrowthGlobalX96 - twPremiumGrowthBelow - twPremiumGrowthAbove;
            twPremiumGrowthOutside =
                twPremiumGrowthGlobalX96 -
                twPremiumGrowthInside -
                twPremiumGrowthAbove -
                lastTwPremiumGrowthX96;
        }

        int256 lowerTwPremiumDivBySqrtPriceGrowthOutside = self[lowerTick].twPremiumDivBySqrtPriceX96;
        int256 upperTwPremiumDivBySqrtPriceGrowthOutside = self[upperTick].twPremiumDivBySqrtPriceX96;

        int256 twPremiumDivBySqrtPriceGrowthBelow =
            currentTick >= lowerTick
                ? lowerTwPremiumDivBySqrtPriceGrowthOutside
                : twPremiumDivBySqrtPriceGrowthGlobalX96 - lowerTwPremiumDivBySqrtPriceGrowthOutside;
        int256 twPremiumDivBySqrtPriceGrowthAbove =
            currentTick < upperTick
                ? upperTwPremiumDivBySqrtPriceGrowthOutside
                : twPremiumDivBySqrtPriceGrowthGlobalX96 - upperTwPremiumDivBySqrtPriceGrowthOutside;

        // TODO verify what if these values overflow; will they have the same effect as before, when using uint256
        // these values can underflow per feeGrowthOutside specs
        return (
            twPremiumGrowthInside,
            twPremiumDivBySqrtPriceGrowthGlobalX96 -
                twPremiumDivBySqrtPriceGrowthBelow -
                twPremiumDivBySqrtPriceGrowthAbove,
            twPremiumGrowthOutside
        );
    }

    // if (liquidityGrossBefore == 0 && liquidityDelta != 0), call this function
    function initialize(
        mapping(int24 => GrowthInfo) storage self,
        int24 tick,
        int24 currentTick,
        GrowthInfo memory globalGrowthInfo
    ) internal {
        // per Uniswap: we assume that all growth before a tick was initialized happened _below_ the tick
        if (tick <= currentTick) {
            self[tick].feeX128 = globalGrowthInfo.feeX128;
            self[tick].twPremiumX96 = globalGrowthInfo.twPremiumX96;
            self[tick].twPremiumDivBySqrtPriceX96 = globalGrowthInfo.twPremiumDivBySqrtPriceX96;
        }
    }

    function clear(mapping(int24 => GrowthInfo) storage self, int24 tick) internal {
        delete self[tick];
    }

    function cross(
        mapping(int24 => GrowthInfo) storage self,
        int24 tick,
        GrowthInfo memory globalGrowthInfo
    ) internal {
        self[tick].feeX128 = globalGrowthInfo.feeX128 - self[tick].feeX128;
        self[tick].twPremiumX96 = globalGrowthInfo.twPremiumX96 - self[tick].twPremiumX96;
        self[tick].twPremiumDivBySqrtPriceX96 =
            globalGrowthInfo.twPremiumDivBySqrtPriceX96 -
            self[tick].twPremiumDivBySqrtPriceX96;
    }
}
