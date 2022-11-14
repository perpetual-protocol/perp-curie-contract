pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../../../contracts/lib/PerpMath.sol";

contract PerpMathTest is Test {
    function test_findMedianOfThree() public {
        assertEq(PerpMath.findMedianOfThree(1, 2, 3), uint256(2));
        assertEq(PerpMath.findMedianOfThree(2, 1, 3), uint256(2));
        assertEq(PerpMath.findMedianOfThree(1, 3, 2), uint256(2));
    }
}
