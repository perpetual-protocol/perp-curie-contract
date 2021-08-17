pragma solidity 0.7.6;

library Tick {
    struct GrowthInfo {
        uint256 feeX128;
        int256 twPremiumX96;
        int256 twPremiumDivBySqrtPriceX96;
    }

    struct FundingGrowthRangeInfo {
        int256 twPremiumGrowthInsideX96;
        int256 twPremiumGrowthBelowX96;
        int256 twPremiumDivBySqrtPriceGrowthInsideX96;
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
        int256 twPremiumDivBySqrtPriceGrowthGlobalX96
    ) internal view returns (FundingGrowthRangeInfo memory fundingGrowthRangeInfo) {
        int256 lowerTwPremiumGrowthOutsideX96 = self[lowerTick].twPremiumX96;
        int256 upperTwPremiumGrowthOutsideX96 = self[upperTick].twPremiumX96;

        fundingGrowthRangeInfo.twPremiumGrowthBelowX96 = currentTick >= lowerTick
            ? lowerTwPremiumGrowthOutsideX96
            : twPremiumGrowthGlobalX96 - lowerTwPremiumGrowthOutsideX96;
        int256 twPremiumGrowthAboveX96 =
            currentTick < upperTick
                ? upperTwPremiumGrowthOutsideX96
                : twPremiumGrowthGlobalX96 - upperTwPremiumGrowthOutsideX96;

        int256 lowerTwPremiumDivBySqrtPriceGrowthOutsideX96 = self[lowerTick].twPremiumDivBySqrtPriceX96;
        int256 upperTwPremiumDivBySqrtPriceGrowthOutsideX96 = self[upperTick].twPremiumDivBySqrtPriceX96;

        int256 twPremiumDivBySqrtPriceGrowthBelowX96 =
            currentTick >= lowerTick
                ? lowerTwPremiumDivBySqrtPriceGrowthOutsideX96
                : twPremiumDivBySqrtPriceGrowthGlobalX96 - lowerTwPremiumDivBySqrtPriceGrowthOutsideX96;
        int256 twPremiumDivBySqrtPriceGrowthAboveX96 =
            currentTick < upperTick
                ? upperTwPremiumDivBySqrtPriceGrowthOutsideX96
                : twPremiumDivBySqrtPriceGrowthGlobalX96 - upperTwPremiumDivBySqrtPriceGrowthOutsideX96;

        // TODO funding verify what if these values overflow; will they have the same effect as using uint256 or not
        // these values can underflow per feeGrowthOutside specs
        fundingGrowthRangeInfo.twPremiumGrowthInsideX96 =
            twPremiumGrowthGlobalX96 -
            fundingGrowthRangeInfo.twPremiumGrowthBelowX96 -
            twPremiumGrowthAboveX96;
        fundingGrowthRangeInfo.twPremiumDivBySqrtPriceGrowthInsideX96 =
            twPremiumDivBySqrtPriceGrowthGlobalX96 -
            twPremiumDivBySqrtPriceGrowthBelowX96 -
            twPremiumDivBySqrtPriceGrowthAboveX96;
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
