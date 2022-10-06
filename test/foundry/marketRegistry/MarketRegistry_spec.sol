pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "./BaseSetup.sol";
import "@uniswap/v3-core/contracts/interfaces/pool/IUniswapV3PoolState.sol";

contract MarketRegistry_spec is BaseSetup {
    function setUp() public virtual override {
        BaseSetup.setUp();
    }

    function testCannot_add_pool_before_pool_is_initialized() public {
        vm.mockCall(
            address(uniswapV3Pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(0, 0, 0, 0, 0, 0, false)
        );
        vm.expectRevert(bytes("MR_PNI"));
        marketRegistry.addPool(address(baseToken), POOL_FEE);
    }
}
