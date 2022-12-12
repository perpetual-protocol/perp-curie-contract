pragma solidity 0.7.6;

import "forge-std/Test.sol";

contract Constant is Test {
    uint24 public constant MAX_RATIO = 1e6;

    address public nonOwnerAddress = makeAddr("nonOwnerAddress");
}
