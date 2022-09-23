pragma solidity 0.7.6;

import "forge-std/Test.sol";

contract HelloTest is Test {
    uint256 testNumber;

    function setUp() public {
        testNumber = 42;
    }

    function testNumberIs42() public {
        assertEq(testNumber, 42);
    }
}
