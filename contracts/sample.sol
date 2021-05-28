pragma solidity 0.7.3;

contract Sample {

    int public c;
    constructor() public {}
    function test(int a, int b) external {
        c = a+b;
    }


}