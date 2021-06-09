pragma solidity 0.7.6;
pragma abicoder v2;

import "../lib/UniswapV3Broker.sol";

contract TestUniswapV3Broker {
    constructor() public {}

    function mint(UniswapV3Broker.MintParams calldata params)
        external
        returns (UniswapV3Broker.MintResponse memory response)
    {
        return UniswapV3Broker.mint(params);
    }
}
