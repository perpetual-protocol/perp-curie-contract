pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../../../contracts/lib/PerpMath.sol";

contract PerpMathTest is Test {
    function test_findMedianOfThree() public {
        assertEq(PerpMath.findMedianOfThree(1, 2, 3), uint256(2));
        assertEq(PerpMath.findMedianOfThree(1, 3, 2), uint256(2));
        assertEq(PerpMath.findMedianOfThree(2, 1, 3), uint256(2));
        assertEq(PerpMath.findMedianOfThree(2, 3, 1), uint256(2));
        assertEq(PerpMath.findMedianOfThree(3, 1, 2), uint256(2));
        assertEq(PerpMath.findMedianOfThree(3, 2, 1), uint256(2));
        assertEq(PerpMath.findMedianOfThree(1, 1, 1), uint256(1));
        assertEq(PerpMath.findMedianOfThree(1, 2, 1), uint256(1));
        assertEq(PerpMath.findMedianOfThree(2, 2, 1), uint256(2));
    }
}
