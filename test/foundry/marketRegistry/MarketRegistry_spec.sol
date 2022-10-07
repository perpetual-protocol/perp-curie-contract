pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "./BaseSetup.sol";
import "../../../contracts/ClearingHouse.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/pool/IUniswapV3PoolState.sol";
import "@uniswap/v3-core/contracts/UniswapV3Pool.sol";

contract MarketRegistry_addPool is BaseSetup {
    event PoolAdded(address indexed baseToken, uint24 indexed feeRatio, address indexed pool);

    function setUp() public virtual override {
        BaseSetup.setUp();
    }

    function test_addPool_should_emit_event() public {
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );

        vm.expectEmit(false, false, false, true);
        emit PoolAdded(address(baseToken), DEFAULT_POOL_FEE, address(pool));
        marketRegistry.addPool(address(baseToken), DEFAULT_POOL_FEE);
        assertEq(marketRegistry.getPool(address(baseToken)), address(pool));
    }

    function test_add_multiple_pools_should_emit_events() public {
        // add first pool
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );

        vm.expectEmit(false, false, false, true);
        emit PoolAdded(address(baseToken), DEFAULT_POOL_FEE, address(pool));
        marketRegistry.addPool(address(baseToken), DEFAULT_POOL_FEE);
        assertEq(marketRegistry.getPool(address(baseToken)), address(pool));

        // create another token and pool
        BaseToken baseToken2 = createBaseToken("BASE2", address(quoteToken), address(clearingHouse), false);
        UniswapV3Pool pool2 = createUniswapV3Pool(uniswapV3Factory, baseToken2, quoteToken, DEFAULT_POOL_FEE);

        // add second pool
        vm.mockCall(
            address(pool2),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        vm.expectEmit(false, false, false, true);
        emit PoolAdded(address(baseToken2), DEFAULT_POOL_FEE, address(pool2));
        marketRegistry.addPool(address(baseToken2), DEFAULT_POOL_FEE);
        assertEq(marketRegistry.getPool(address(baseToken2)), address(pool2));
    }

    function testCannot_addPool_if_pool_is_not_initialized() public {
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(0, 0, 0, 0, 0, 0, false)
        );
        vm.expectRevert(bytes("MR_PNI"));
        marketRegistry.addPool(address(baseToken), DEFAULT_POOL_FEE);
    }

    function testCannot_addPool_if_pool_does_not_exist() public {
        BaseToken baseToken2 = createBaseToken("BASE2", address(quoteToken), address(clearingHouse), false);
        vm.mockCall(
            address(uniswapV3Factory),
            abi.encodeWithSelector(IUniswapV3Factory.getPool.selector),
            abi.encode(0)
        );
        vm.expectRevert(bytes("MR_NEP"));
        marketRegistry.addPool(address(baseToken2), DEFAULT_POOL_FEE);
    }

    function testCannot_addPool_if_pool_already_exists_in_ClearingHouse() public {
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        marketRegistry.addPool(address(baseToken), DEFAULT_POOL_FEE);
        // should be failed if try to add poll again
        vm.expectRevert(bytes("MR_EP"));
        marketRegistry.addPool(address(baseToken), DEFAULT_POOL_FEE);
    }

    function testCannot_addPool_with_same_base_quote_but_diff_uniswap_fee() public {
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        marketRegistry.addPool(address(baseToken), DEFAULT_POOL_FEE);

        // create another uniswapPool with different fee
        createUniswapV3Pool(uniswapV3Factory, baseToken, quoteToken, 10000);

        vm.expectRevert(bytes("MR_EP"));
        marketRegistry.addPool(address(baseToken), 10000);
    }

    function testCannot_addPool_if_base_address_is_greater_than_quote_address() public {
        BaseToken baseToken2 = createBaseToken("BASE2", address(quoteToken), address(clearingHouse), true);
        UniswapV3Pool pool2 = createUniswapV3Pool(uniswapV3Factory, baseToken2, quoteToken, DEFAULT_POOL_FEE);
        vm.mockCall(
            address(pool2),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        vm.expectRevert(bytes("MR_IB"));
        marketRegistry.addPool(address(baseToken2), DEFAULT_POOL_FEE);
    }

    function testCannot_addPool_if_clearingHouse_has_insufficient_base_token_balance() public {
        BaseToken baseToken2 = createBaseToken("BASE2", address(quoteToken), makeAddr("FAKE"), false);
        UniswapV3Pool pool2 = createUniswapV3Pool(uniswapV3Factory, baseToken2, quoteToken, DEFAULT_POOL_FEE);
        vm.mockCall(
            address(pool2),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        vm.expectRevert(bytes("MR_CHBNE"));
        marketRegistry.addPool(address(baseToken2), DEFAULT_POOL_FEE);
    }
}

contract MarketRegistry_setter is BaseSetup {
    event ClearingHouseChanged(address indexed clearingHouse);
    event FeeRatioChanged(address baseToken, uint24 feeRatio);
    event InsuranceFundFeeRatioChanged(address baseToken, uint24 feeRatio);
    event MaxOrdersPerMarketChanged(uint8 maxOrdersPerMarket);

    address nonOwnerAddress;

    function setUp() public virtual override {
        BaseSetup.setUp();
        nonOwnerAddress = makeAddr("nonOwnerAddress");
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        marketRegistry.addPool(address(baseToken), DEFAULT_POOL_FEE);
    }

    function test_setClearingHouse_should_emit_event() public {
        ClearingHouse clearingHouse2 = createClearingHouse();
        vm.expectEmit(false, false, false, true);
        emit ClearingHouseChanged(address(clearingHouse2));
        marketRegistry.setClearingHouse(address(clearingHouse2));
        assertEq(marketRegistry.getClearingHouse(), address(clearingHouse2));
    }

    function testCannot_setClearingHouse_if_called_by_non_owner() public {
        ClearingHouse clearingHouse2 = createClearingHouse();
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        marketRegistry.setClearingHouse(address(clearingHouse2));
    }

    function test_setMaxOrdersPerMarket_should_emit_event() public {
        vm.expectEmit(false, false, false, true);
        emit MaxOrdersPerMarketChanged(1);
        marketRegistry.setMaxOrdersPerMarket(1);
        assertEq(uint256(marketRegistry.getMaxOrdersPerMarket()), 1);
    }

    function testCannot_setMaxOrdersPerMarket_if_called_by_non_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        marketRegistry.setMaxOrdersPerMarket(1);
    }

    function test_setFeeRatio_should_emit_event() public {
        vm.expectEmit(false, false, false, true);
        emit FeeRatioChanged(address(baseToken), 10000);
        marketRegistry.setFeeRatio(address(baseToken), 10000);
    }

    function testCannot_setFeeRatio_if_called_by_non_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        marketRegistry.setFeeRatio(address(baseToken), 10000);
    }

    function testCannot_setFeeRatio_if_overflow() public {
        uint24 twoHundredPercent = 2000000; // 200% in uint24
        vm.expectRevert(bytes("MR_RO"));
        marketRegistry.setFeeRatio(address(baseToken), twoHundredPercent);
    }

    function testCannot_setFeeRatio_if_pool_does_not_exist_in_ClearingHouse() public {
        BaseToken baseToken2 = createBaseToken("BASE2", address(quoteToken), address(clearingHouse), false);
        vm.expectRevert(bytes("MR_PNE"));
        marketRegistry.setFeeRatio(address(baseToken2), 10000);
    }

    function test_setInsuranceFundFeeRatio_should_emit_event() public {
        vm.expectEmit(false, false, false, true);
        emit InsuranceFundFeeRatioChanged(address(baseToken), 10000);
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken), 10000);
    }

    function testCannot_setInsuranceFundFeeRatio_if_called_by_non_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken), 10000);
    }

    function testCannot_setInsuranceFundFeeRatio_if_overflow() public {
        uint24 twoHundredPercent = 2000000; // 200% in uint24
        vm.expectRevert(bytes("MR_RO"));
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken), twoHundredPercent);
    }

    function testCannot_setInsuranceFundFeeRatio_if_pool_does_not_exist_in_ClearingHouse() public {
        BaseToken baseToken2 = createBaseToken("BASE2", address(quoteToken), address(clearingHouse), false);
        vm.expectRevert(bytes("MR_PNE"));
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken2), 10000);
    }
}
