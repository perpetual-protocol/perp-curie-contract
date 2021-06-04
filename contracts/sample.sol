pragma solidity 0.8.4;

contract Sample {
    int256 public c;

    constructor() public {}

    function test(int256 a, int256 b) external {
        c = a + b;
    }
}
