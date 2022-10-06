pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "./BaseSetup.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/pool/IUniswapV3PoolState.sol";
import "@uniswap/v3-core/contracts/UniswapV3Pool.sol";

contract MarketRegistry_spec is BaseSetup {
    event PoolAdded(address indexed baseToken, uint24 indexed feeRatio, address indexed pool);

    function setUp() public virtual override {
        BaseSetup.setUp();
    }

    function test_add_pool_successfully_and_should_emit_event() public {
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );

        vm.expectEmit(false, false, false, true);
        emit PoolAdded(address(baseToken), POOL_FEE, address(pool));
        marketRegistry.addPool(address(baseToken), POOL_FEE);
        assertEq(marketRegistry.getPool(address(baseToken)), address(pool));
    }

    function test_add_multiple_pools_successfully_and_should_emit_events() public {
        // add first pool
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );

        vm.expectEmit(false, false, false, true);
        emit PoolAdded(address(baseToken), POOL_FEE, address(pool));
        marketRegistry.addPool(address(baseToken), POOL_FEE);
        assertEq(marketRegistry.getPool(address(baseToken)), address(pool));

        // create another token and pool
        BaseToken baseToken2 = createBaseToken("BASE2", address(quoteToken), address(clearingHouse));
        UniswapV3Pool pool2 = createUniswapV3Pool(uniswapV3Factory, baseToken2, quoteToken);

        // add second pool
        vm.mockCall(
            address(pool2),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        vm.expectEmit(false, false, false, true);
        emit PoolAdded(address(baseToken2), POOL_FEE, address(pool2));
        marketRegistry.addPool(address(baseToken2), POOL_FEE);
        assertEq(marketRegistry.getPool(address(baseToken2)), address(pool2));
    }

    function testCannot_add_pool_before_pool_is_initialized() public {
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(0, 0, 0, 0, 0, 0, false)
        );
        vm.expectRevert(bytes("MR_PNI"));
        marketRegistry.addPool(address(baseToken), POOL_FEE);
    }

    function testCannot_add_pool_if_pool_does_not_exist() public {
        BaseToken baseToken2 = createBaseToken("BASE2", address(quoteToken), address(clearingHouse));
        vm.mockCall(
            address(uniswapV3Factory),
            abi.encodeWithSelector(IUniswapV3Factory.getPool.selector),
            abi.encode(0)
        );
        vm.expectRevert(bytes("MR_NEP"));
        marketRegistry.addPool(address(baseToken2), POOL_FEE);
    }
}
