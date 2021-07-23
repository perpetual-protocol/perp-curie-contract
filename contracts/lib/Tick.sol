pragma solidity 0.7.6;

library Tick {
    function getFeeGrowthInside(
        mapping(int24 => uint256) storage self,
        int24 lowerTick,
        int24 upperTick,
        int24 currentTick,
        uint256 feeGrowthGlobalX128
    ) internal view returns (uint256 feeGrowthInsideQuote) {
        uint256 lowerFeeGrowthOutside = self[lowerTick];
        uint256 upperFeeGrowthOutside = self[upperTick];

        uint256 feeGrowthBelow =
            currentTick >= lowerTick ? lowerFeeGrowthOutside : feeGrowthGlobalX128 - lowerFeeGrowthOutside;
        uint256 feeGrowthAbove =
            currentTick < upperTick ? upperFeeGrowthOutside : feeGrowthGlobalX128 - upperFeeGrowthOutside;

        // this value can underflow per feeGrowthOutside specs
        return feeGrowthGlobalX128 - feeGrowthBelow - feeGrowthAbove;
    }

    // if (liquidityGrossBefore == 0 && liquidityDelta != 0), call this function
    function initialize(
        mapping(int24 => uint256) storage self,
        int24 tick,
        int24 currentTick,
        uint256 feeGrowthGlobalX128
    ) internal {
        // per Uniswap: we assume that all growth before a tick was initialized happened _below_ the tick
        if (tick <= currentTick) {
            self[tick] = feeGrowthGlobalX128;
        }
    }

    function clear(mapping(int24 => uint256) storage self, int24 tick) internal {
        delete self[tick];
    }

    function cross(
        mapping(int24 => uint256) storage self,
        int24 tick,
        uint256 feeGrowthGlobalBaseToQuoteX128
    ) internal {
        self[tick] = feeGrowthGlobalBaseToQuoteX128 - self[tick];
    }
}
