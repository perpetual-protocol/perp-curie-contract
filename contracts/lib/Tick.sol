pragma solidity 0.7.6;
import "hardhat/console.sol";

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

        console.log("--------------------");
        console.log("lowerTick", uint256(lowerTick));
        console.log("upperTick", uint256(upperTick));
        console.log("currentTick", uint256(currentTick));
        console.log("feeGrowthGlobalX128", feeGrowthGlobalX128);
        console.log("lowerFeeGrowthOutside", lowerFeeGrowthOutside);
        console.log("upperFeeGrowthOutside", upperFeeGrowthOutside);
        console.log("feeGrowthBelow", feeGrowthBelow);
        console.log("feeGrowthAbove", feeGrowthAbove);
        console.log("--------------------");

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
        uint256 feeGrowthGlobalX128
    ) internal {
        // console.log("");
        // console.log("CH");
        // console.log("cross start");
        // console.log("tick", uint256(tick));
        // console.log("feeGrowthGlobalX128", feeGrowthGlobalX128);
        // console.log("before cross", self[tick]);
        self[tick] = feeGrowthGlobalX128 - self[tick];
        // console.log("after cross", self[tick]);
        // console.log("cross end");
        // console.log("");
    }
}
