pragma solidity 0.7.6;
pragma abicoder v2;

import "../lib/UniswapBroker.sol";

contract TestUniswapBroker {
    constructor() public {}

    function mint(UniswapBroker.MintParams calldata params)
        external
        returns (UniswapBroker.MintResponse memory response)
    {
        return UniswapBroker.mint(params);
    }
}
