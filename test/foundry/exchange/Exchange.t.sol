pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../helper/Setup.sol";
import "../interface/IExchangeEvent.sol";

contract ExchangeTest is IExchangeEvent, Setup {
    function setUp() public virtual override {
        Setup.setUp();
    }

    function test_setPriceBand_when_owner() public {
        vm.expectEmit(true, true, true, true, address(exchange));
        emit PriceBandChanged(address(baseToken), 0.1e6);
        exchange.setPriceBand(address(baseToken), 0.1e6); // 10%
    }

    function test_setPriceBand_when_not_owner() public {
        address notOwner = makeAddr("notOwner");
        vm.prank(notOwner);
        vm.expectRevert(bytes("SO_CNO"));
        exchange.setPriceBand(address(baseToken), 0.1e6); // 10%
    }

    function test_getPriceBand() public {
        assertEq(uint256(exchange.getPriceBand(address(baseToken))), 0); // default is 0
        exchange.setPriceBand(address(baseToken), uint24(0.1e6));
        assertEq(uint256(exchange.getPriceBand(address(baseToken))), 0.1e6);
    }
}
